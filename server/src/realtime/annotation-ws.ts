import {
  parseAnnotationCommand,
  parseAnnotationCommandResponse,
  parseAnnotationServerMessage,
  parseAnnotationSoftLockIntent,
} from '@volleyball-monitoring/contracts'
import type { AnnotationRallySnapshot } from '@volleyball-monitoring/contracts'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import type {
  AnnotationCommandService,
  AnnotationIdentity,
} from '../services/annotation-command.js'
import type { AnnotationSnapshotEventService } from './annotation-events.js'
import type { AnnotationPresenceService } from './annotation-presence.js'
import type { AiProgressService } from './ai-progress.js'

export interface AnnotationWebSocketDependencies {
  authenticate: (request: FastifyRequest) => Promise<AnnotationIdentity | null>
  events?: AnnotationSnapshotEventService
  presence?: AnnotationPresenceService
  progress?: AiProgressService
  reconcileIntervalMs?: number
  service: AnnotationCommandService
  snapshot?: (
    roomId: string,
    rallyId: string,
    identity: AnnotationIdentity,
  ) => Promise<AnnotationRallySnapshot | null>
}

interface AnnotationSocketLike {
  readyState: number
  close(code?: number, reason?: string): void
  send(payload: string): void
}

interface AnnotationPeer {
  identity: AnnotationIdentity
  sentSnapshots: Map<string, { revision: bigint; serverSequence: bigint }>
  socket: AnnotationSocketLike
}

interface AnnotationRoomState {
  lastSequence: bigint
  peers: Set<AnnotationPeer>
  reconciling: boolean
}

const REPLAY_BATCH_SIZE = 512
const REPLAY_BATCHES_ON_CONNECT = 16
const REPLAY_BATCHES_ON_RECONCILE = 4

function invalidCommandRejection(payload: unknown, roomId: string) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const candidate = payload as Record<string, unknown>
  if (
    !['2.0.0', '3.0.0', '4.0.0'].includes(String(candidate.schema_version)) ||
    typeof candidate.command_id !== 'string' ||
    typeof candidate.room_id !== 'string' ||
    typeof candidate.rally_id !== 'string' ||
    candidate.room_id !== roomId
  )
    return null
  try {
    return parseAnnotationCommandResponse({
      schema_version: candidate.schema_version,
      type: 'command_rejected',
      command_id: candidate.command_id,
      room_id: candidate.room_id,
      rally_id: candidate.rally_id,
      code: 'INVALID_COMMAND',
      message: '標註命令格式不相容，請重新整理頁面後再試一次',
      snapshot_refetch_required: false,
    })
  } catch {
    return null
  }
}

function parseResumeSequence(value: string | undefined): bigint | null {
  if (value === undefined) return null
  if (!/^\d+$/.test(value)) throw new TypeError('last_server_sequence must be a decimal bigint')
  return BigInt(value)
}

export const annotationWebSocketRoutes =
  (deps: AnnotationWebSocketDependencies): FastifyPluginAsync =>
  async app => {
    const rooms = new Map<string, AnnotationRoomState>()
    const activeRallyLoads = new Map<string, Promise<string[]>>()
    const snapshotLoads = new Map<string, Promise<AnnotationRallySnapshot | null>>()
    const reconcileIntervalMs = Math.max(500, deps.reconcileIntervalMs ?? 2_000)

    const roomState = (roomId: string) => {
      const existing = rooms.get(roomId)
      if (existing) return existing
      const created: AnnotationRoomState = {
        lastSequence: 0n,
        peers: new Set(),
        reconciling: false,
      }
      rooms.set(roomId, created)
      return created
    }

    const sendSnapshot = (peer: AnnotationPeer, snapshot: AnnotationRallySnapshot) => {
      if (peer.socket.readyState !== 1) return
      const next = {
        revision: BigInt(snapshot.revision),
        serverSequence: BigInt(snapshot.server_sequence),
      }
      const prior = peer.sentSnapshots.get(snapshot.rally_id)
      if (
        prior &&
        next.revision <= prior.revision &&
        next.serverSequence <= prior.serverSequence
      )
        return
      peer.sentSnapshots.set(snapshot.rally_id, next)
      peer.socket.send(JSON.stringify(snapshot))
    }

    const broadcastSnapshot = (snapshot: AnnotationRallySnapshot) => {
      const state = rooms.get(snapshot.room_id)
      if (!state) return
      const sequence = BigInt(snapshot.server_sequence)
      if (sequence > state.lastSequence) state.lastSequence = sequence
      for (const peer of state.peers) sendSnapshot(peer, snapshot)
    }

    const loadActiveRallyIds = (room: { roomId: string; matchId: string; captureSessionId: string }) => {
      const existing = activeRallyLoads.get(room.roomId)
      if (existing) return existing
      const pending = deps.service.activeRoomRallyIds(room).finally(() => {
        if (activeRallyLoads.get(room.roomId) === pending) activeRallyLoads.delete(room.roomId)
      })
      activeRallyLoads.set(room.roomId, pending)
      return pending
    }

    const loadSnapshot = (
      roomId: string,
      rallyId: string,
      identity: AnnotationIdentity,
    ) => {
      if (!deps.snapshot) return Promise.resolve(null)
      const key = `${roomId}:${rallyId}`
      const existing = snapshotLoads.get(key)
      if (existing) return existing
      const pending = deps.snapshot(roomId, rallyId, identity).finally(() => {
        if (snapshotLoads.get(key) === pending) snapshotLoads.delete(key)
      })
      snapshotLoads.set(key, pending)
      return pending
    }

    const replayChanges = async (
      roomId: string,
      afterSequence: bigint,
      identity: AnnotationIdentity,
      deliver: (snapshot: AnnotationRallySnapshot) => void,
      maxBatches: number,
    ) => {
      let cursor = afterSequence
      let current = afterSequence
      let hasMore = false
      for (let batch = 0; batch < maxBatches; batch += 1) {
        const changes = await deps.service.roomChangesAfter(roomId, cursor, REPLAY_BATCH_SIZE)
        current = changes.currentSequence
        for (const rallyId of changes.rallyIds) {
          const snapshot = await loadSnapshot(roomId, rallyId, identity)
          if (snapshot) deliver(snapshot)
        }
        hasMore = changes.hasMore
        if (changes.throughSequence <= cursor || !changes.hasMore) {
          cursor = changes.throughSequence
          break
        }
        cursor = changes.throughSequence
      }
      return { current, cursor, hasMore }
    }

    const reconcileRoom = async (roomId: string, state: AnnotationRoomState) => {
      if (state.reconciling || !state.peers.size) return
      state.reconciling = true
      try {
        const current = await deps.service.roomSequence(roomId)
        if (current <= state.lastSequence) return
        const representative = state.peers.values().next().value as AnnotationPeer | undefined
        if (!representative || !deps.snapshot) {
          state.lastSequence = current
          return
        }
        const replay = await replayChanges(
          roomId,
          state.lastSequence,
          representative.identity,
          broadcastSnapshot,
          REPLAY_BATCHES_ON_RECONCILE,
        )
        if (replay.cursor > state.lastSequence) state.lastSequence = replay.cursor
      } catch (cause) {
        app.log.warn({ err: cause, room_id: roomId }, 'annotation room reconciliation failed')
      } finally {
        state.reconciling = false
      }
    }

    const reconcileTimer = setInterval(() => {
      for (const [roomId, state] of rooms) void reconcileRoom(roomId, state)
    }, reconcileIntervalMs)
    reconcileTimer.unref?.()
    app.addHook('onClose', async () => {
      clearInterval(reconcileTimer)
      activeRallyLoads.clear()
      snapshotLoads.clear()
      rooms.clear()
    })

    app.get<{
      Querystring: {
        last_server_sequence?: string
        room_id?: string
      }
    }>(
      '/ws/annotations',
      { websocket: true },
      (socket, request) => {
        void (async () => {
          const roomId = request.query.room_id
          if (!roomId) {
            socket.close(1008, 'room_id is required')
            return
          }
          let resumeSequence: bigint | null
          try {
            resumeSequence = parseResumeSequence(request.query.last_server_sequence)
          } catch {
            socket.close(1008, 'last_server_sequence is invalid')
            return
          }
          let identity: AnnotationIdentity | null
          try {
            identity = await deps.authenticate(request)
          } catch {
            socket.close(1008, 'authentication failed')
            return
          }
          if (!identity) {
            socket.close(1008, 'authentication required')
            return
          }
          const room = await deps.service.authorizeRoom(roomId, identity)
          if (!room || room.roomId !== roomId.toLowerCase()) {
            socket.close(1008, 'annotation room not found')
            return
          }

          const state = roomState(room.roomId)
          const roomWasEmpty = state.peers.size === 0
          const peer: AnnotationPeer = { identity, sentSnapshots: new Map(), socket }
          state.peers.add(peer)
          const leaveRoom = () => {
            state.peers.delete(peer)
            if (!state.peers.size) rooms.delete(room.roomId)
          }
          socket.on('close', leaveRoom)

          let heartbeat: ReturnType<typeof setInterval> | null = null
          let unsubscribeEvents: (() => void) | null = null
          let unsubscribePresence: (() => void) | null = null
          let unsubscribeProgress: (() => void) | null = null
          let presenceMember: Awaited<ReturnType<AnnotationPresenceService['join']>> | null = null
          let presenceCleaned = false
          const sendPresence = async () => {
            if (!deps.presence || socket.readyState !== 1) return
            socket.send(JSON.stringify(await deps.presence.snapshot(room.roomId)))
          }
          const cleanupPresence = async () => {
            if (presenceCleaned) return
            presenceCleaned = true
            if (heartbeat) clearInterval(heartbeat)
            unsubscribeEvents?.()
            unsubscribePresence?.()
            unsubscribeProgress?.()
            if (deps.presence && presenceMember)
              await deps.presence
                .leave(room.roomId, presenceMember.device_session_id)
                .catch(() => undefined)
          }
          socket.on('close', () => {
            void cleanupPresence()
          })

          if (deps.events) {
            try {
              unsubscribeEvents = await deps.events.subscribe(room.roomId, snapshot => {
                const sequence = BigInt(snapshot.server_sequence)
                if (sequence > state.lastSequence) state.lastSequence = sequence
                sendSnapshot(peer, snapshot)
              })
            } catch {
              await cleanupPresence()
              socket.close(1011, 'annotation event stream unavailable')
              return
            }
          }

          if (deps.presence) {
            try {
              presenceMember = await deps.presence.join(room.roomId, identity)
              const presenceSnapshot = await deps.presence.snapshot(room.roomId)
              await deps.service.recoverAbandonedDraft(
                room.roomId,
                identity,
                presenceSnapshot.members.map(member => member.device_session_id),
              )
              unsubscribePresence = await deps.presence.subscribe(room.roomId, () => {
                void sendPresence().catch(() => undefined)
              })
              heartbeat = setInterval(() => {
                if (deps.presence && presenceMember)
                  void deps.presence
                    .touch(room.roomId, presenceMember)
                    .catch(() => socket.close(1011, 'presence heartbeat failed'))
              }, 10_000)
            } catch {
              await cleanupPresence()
              socket.close(1011, 'presence unavailable')
              return
            }
          }

          let readySequence = await deps.service.roomSequence(room.roomId)
          if (resumeSequence !== null && deps.snapshot) {
            try {
              const replay = await replayChanges(
                room.roomId,
                resumeSequence,
                identity,
                snapshot => sendSnapshot(peer, snapshot),
                REPLAY_BATCHES_ON_CONNECT,
              )
              readySequence = replay.cursor
            } catch (cause) {
              request.log.warn(
                { err: cause, room_id: room.roomId },
                'annotation reconnect replay failed; background reconciliation will retry',
              )
              if (resumeSequence < readySequence) readySequence = resumeSequence
            }
          }
          if (deps.snapshot) {
            try {
              const activeRallyIds = await loadActiveRallyIds(room)
              for (const rallyId of activeRallyIds) {
                const activeSnapshot = await loadSnapshot(room.roomId, rallyId, identity)
                if (activeSnapshot) sendSnapshot(peer, activeSnapshot)
              }
            } catch (cause) {
              request.log.warn(
                { err: cause, room_id: room.roomId },
                'active annotation room projection failed to load',
              )
            }
          }
          if (roomWasEmpty && readySequence > state.lastSequence)
            state.lastSequence = readySequence
          const ready = parseAnnotationServerMessage({
            schema_version: '2.0.0',
            type: 'connection_ready',
            authenticated_user_id: identity.userId,
            device_session_id: identity.deviceSessionId,
            room_id: room.roomId,
            server_sequence: readySequence.toString(),
          })
          socket.send(JSON.stringify(ready))
          await sendPresence()
          if (deps.progress) {
            try {
              unsubscribeProgress = await deps.progress.subscribe(room.roomId, message => {
                if (socket.readyState === 1) socket.send(JSON.stringify(message))
              })
            } catch {
              await cleanupPresence()
              socket.close(1011, 'AI progress stream unavailable')
              return
            }
          }

          socket.on('message', raw => {
            void (async () => {
              let payload: unknown
              try {
                payload = JSON.parse(raw.toString())
              } catch {
                socket.close(1003, 'invalid annotation message')
                return
              }
              try {
                const intent = parseAnnotationSoftLockIntent(payload)
                if (intent.room_id !== room.roomId) {
                  socket.close(1008, 'soft-lock room mismatch')
                  return
                }
                if (!deps.presence || !presenceMember) {
                  socket.close(1011, 'soft-lock presence unavailable')
                  return
                }
                try {
                  presenceMember = await deps.presence.setEditing(
                    room.roomId,
                    presenceMember,
                    intent.editing_key_point_id,
                  )
                  // The origin gets a direct heartbeat response. Room-wide fan-out
                  // only occurs when the semantic edit target actually changes.
                  await sendPresence()
                  return
                } catch {
                  socket.close(1011, 'soft-lock update failed')
                  return
                }
              } catch {
                /* not a soft-lock intent; continue with the durable command parser */
              }
              let command
              try {
                command = parseAnnotationCommand(payload)
              } catch (cause) {
                const rejection = invalidCommandRejection(payload, room.roomId)
                if (rejection) {
                  request.log.warn(
                    { err: cause, annotation_command_id: rejection.command_id },
                    'invalid annotation command rejected without disconnecting websocket',
                  )
                  socket.send(JSON.stringify(rejection))
                  return
                }
                socket.close(1003, 'invalid annotation command')
                return
              }
              if (command.room_id !== room.roomId) {
                socket.close(1008, 'command room mismatch')
                return
              }
              try {
                const response = await deps.service.apply(command, identity)
                const responsePayload = JSON.stringify(response)
                if (response.type === 'command_ack') {
                  socket.send(responsePayload)
                  const snapshot = await loadSnapshot(room.roomId, response.rally_id, identity)
                  if (snapshot) {
                    if (deps.events) {
                      await deps.events.publish(snapshot).catch(cause => {
                        request.log.warn(
                          { err: cause, room_id: room.roomId },
                          'Redis annotation fan-out failed; using local delivery and DB reconciliation',
                        )
                        broadcastSnapshot(snapshot)
                      })
                    } else broadcastSnapshot(snapshot)
                  }
                } else socket.send(responsePayload)
              } catch (cause) {
                request.log.error(
                  {
                    err: cause,
                    annotation_command_id: command.command_id,
                    annotation_command_kind: command.kind,
                    rally_id: command.rally_id,
                  },
                  'annotation command failed',
                )
                socket.close(1011, 'annotation command failed')
              }
            })()
          })
        })()
      },
    )
  }
