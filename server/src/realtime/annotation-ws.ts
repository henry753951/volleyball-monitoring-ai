import {
  parseAnnotationCommand,
  parseAnnotationServerMessage,
  parseAnnotationSoftLockIntent,
} from '@volleyball-monitoring/contracts'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import type {
  AnnotationRallySnapshot,
} from '@volleyball-monitoring/contracts'
import type {
  AnnotationCommandService,
  AnnotationIdentity,
} from '../services/annotation-command.js'
import type { AnnotationPresenceService } from './annotation-presence.js'
import type { AiProgressService } from './ai-progress.js'

export interface AnnotationWebSocketDependencies {
  authenticate: (request: FastifyRequest) => Promise<AnnotationIdentity | null>
  presence?: AnnotationPresenceService
  progress?: AiProgressService
  service: AnnotationCommandService
  snapshot?: (roomId: string, rallyId: string, identity: AnnotationIdentity) => Promise<AnnotationRallySnapshot | null>
}

export const annotationWebSocketRoutes = (
  deps: AnnotationWebSocketDependencies,
): FastifyPluginAsync => async (app) => {
  const roomSockets = new Map<string, Set<{ readyState: number; send: (payload: string) => void }>>()
  app.get<{ Querystring: { room_id?: string } }>(
    '/ws/annotations',
    { websocket: true },
    (socket, request) => {
      void (async () => {
        const roomId = request.query.room_id
        if (!roomId) {
          socket.close(1008, 'room_id is required')
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
        const peers = roomSockets.get(room.roomId) ?? new Set()
        peers.add(socket)
        roomSockets.set(room.roomId, peers)
        const leaveRoom = () => {
          peers.delete(socket)
          if (!peers.size) roomSockets.delete(room.roomId)
        }
        socket.on('close', leaveRoom)
        const ready = parseAnnotationServerMessage({
          schema_version: '2.0.0',
          type: 'connection_ready',
          authenticated_user_id: identity.userId,
          device_session_id: identity.deviceSessionId,
          room_id: room.roomId,
          server_sequence: (await deps.service.roomSequence(room.roomId)).toString(),
        })
        socket.send(JSON.stringify(ready))

        let heartbeat: ReturnType<typeof setInterval> | null = null
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
          unsubscribePresence?.()
          unsubscribeProgress?.()
          if (deps.presence && presenceMember) await deps.presence.leave(room.roomId, presenceMember.device_session_id).catch(() => undefined)
        }
        socket.on('close', () => { void cleanupPresence() })
        if (deps.presence) {
          try {
            presenceMember = await deps.presence.join(room.roomId, identity)
            unsubscribePresence = await deps.presence.subscribe(room.roomId, () => { void sendPresence().catch(() => undefined) })
            await sendPresence()
            heartbeat = setInterval(() => {
              if (deps.presence && presenceMember) void deps.presence.touch(room.roomId, presenceMember).catch(() => socket.close(1011, 'presence heartbeat failed'))
            }, 10_000)
          }
          catch {
            await cleanupPresence()
            socket.close(1011, 'presence unavailable')
            return
          }
        }
        if (deps.progress) {
          try {
            unsubscribeProgress = await deps.progress.subscribe(room.roomId, (message) => {
              if (socket.readyState === 1) socket.send(JSON.stringify(message))
            })
          }
          catch {
            await cleanupPresence()
            socket.close(1011, 'AI progress stream unavailable')
            return
          }
        }

        socket.on('message', (raw) => {
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
                presenceMember = await deps.presence.setEditing(room.roomId, presenceMember, intent.editing_key_point_id)
                return
              } catch {
                socket.close(1011, 'soft-lock update failed')
                return
              }
            }
            catch { /* not a soft-lock intent; continue with the durable command parser */ }
            let command
            try {
              command = parseAnnotationCommand(payload)
            } catch {
              socket.close(1003, 'invalid annotation command')
              return
            }
            if (command.room_id !== room.roomId) {
              socket.close(1008, 'command room mismatch')
              return
            }
            try {
              const response = await deps.service.apply(command, identity)
              const payload = JSON.stringify(response)
              if (response.type === 'command_ack') {
                // The originator needs the command-specific ACK. Peers only need
                // the committed room snapshot, which avoids redundant messages.
                socket.send(payload)
                const snapshot = await deps.snapshot?.(room.roomId, response.rally_id, identity)
                if (snapshot) {
                  const snapshotPayload = JSON.stringify(snapshot)
                  for (const peer of roomSockets.get(room.roomId) ?? []) {
                    if (peer.readyState === 1) peer.send(snapshotPayload)
                  }
                }
              }
              else socket.send(payload)
            } catch {
              socket.close(1011, 'annotation command failed')
            }
          })()
        })
      })()
    },
  )
}
