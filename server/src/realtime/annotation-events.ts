import { randomUUID } from 'node:crypto'
import {
  parseAnnotationServerMessage,
  type AnnotationRallySnapshot,
} from '@volleyball-monitoring/contracts'

interface RedisSubscriberLike {
  psubscribe(pattern: string): Promise<unknown>
  on(event: 'pmessage', listener: (pattern: string, channel: string, message: string) => void): this
  disconnect(): void
}

export interface AnnotationEventRedisLike {
  duplicate(): RedisSubscriberLike
  publish(channel: string, message: string): Promise<number>
}

export interface AnnotationSnapshotEventService {
  publish(message: AnnotationRallySnapshot): Promise<void>
  subscribe(
    roomId: string,
    listener: (message: AnnotationRallySnapshot) => void,
  ): Promise<() => void>
  close(): void
}

interface SnapshotEnvelope {
  source_id: string
  snapshot: AnnotationRallySnapshot
}

const CHANNEL_PREFIX = 'vmai:annotation:rally-snapshots:v1:'
const channelFor = (roomId: string) => `${CHANNEL_PREFIX}${roomId}`

export function createAnnotationSnapshotEventService(
  redis: AnnotationEventRedisLike,
): AnnotationSnapshotEventService {
  const sourceId = randomUUID()
  const subscriber = redis.duplicate()
  const listeners = new Map<string, Set<(message: AnnotationRallySnapshot) => void>>()
  let subscribeStarted: Promise<void> | null = null

  const dispatch = (message: AnnotationRallySnapshot) => {
    for (const listener of listeners.get(message.room_id) ?? []) listener(message)
  }

  subscriber.on('pmessage', (_pattern, channel, serialized) => {
    if (!channel.startsWith(CHANNEL_PREFIX)) return
    const roomId = channel.slice(CHANNEL_PREFIX.length)
    try {
      const envelope = JSON.parse(serialized) as Partial<SnapshotEnvelope>
      if (envelope.source_id === sourceId || !envelope.snapshot) return
      const message = parseAnnotationServerMessage(envelope.snapshot)
      if (message.type !== 'rally_snapshot' || message.room_id !== roomId) return
      dispatch(message)
    } catch {
      /* malformed ephemeral fan-out messages are repaired by durable DB replay */
    }
  })

  return {
    async publish(input) {
      const message = parseAnnotationServerMessage(input)
      if (message.type !== 'rally_snapshot') {
        throw new TypeError('annotation snapshot event contract mismatch')
      }
      // Local clients must remain responsive even while Redis is degraded.
      dispatch(message)
      await redis.publish(
        channelFor(message.room_id),
        JSON.stringify({ source_id: sourceId, snapshot: message } satisfies SnapshotEnvelope),
      )
    },
    async subscribe(roomId, listener) {
      if (!subscribeStarted) {
        subscribeStarted = subscriber.psubscribe(`${CHANNEL_PREFIX}*`).then(() => undefined)
      }
      await subscribeStarted
      const roomListeners = listeners.get(roomId) ?? new Set()
      roomListeners.add(listener)
      listeners.set(roomId, roomListeners)
      return () => {
        roomListeners.delete(listener)
        if (!roomListeners.size) listeners.delete(roomId)
      }
    },
    close() {
      listeners.clear()
      subscriber.disconnect()
    },
  }
}
