import {
  parseAnnotationServerMessage,
  type AnnotationRallyProcessingUpdate,
} from '@volleyball-monitoring/contracts'

interface RedisSubscriberLike {
  psubscribe(pattern: string): Promise<unknown>
  on(event: 'pmessage', listener: (pattern: string, channel: string, message: string) => void): this
  disconnect(): void
}

export interface AiProgressRedisLike {
  duplicate(): RedisSubscriberLike
  publish(channel: string, message: string): Promise<number>
}

export interface AiProgressService {
  publish(message: AnnotationRallyProcessingUpdate): Promise<void>
  subscribe(
    roomId: string,
    listener: (message: AnnotationRallyProcessingUpdate) => void,
  ): Promise<() => void>
  close(): void
}

const CHANNEL_PREFIX = 'vmai:annotation:ai-progress:v1:'
const channelFor = (roomId: string) => `${CHANNEL_PREFIX}${roomId}`

export function createAiProgressService(redis: AiProgressRedisLike): AiProgressService {
  const subscriber = redis.duplicate()
  const listeners = new Map<string, Set<(message: AnnotationRallyProcessingUpdate) => void>>()
  let subscribeStarted: Promise<void> | null = null

  subscriber.on('pmessage', (_pattern, channel, serialized) => {
    if (!channel.startsWith(CHANNEL_PREFIX)) return
    const roomId = channel.slice(CHANNEL_PREFIX.length)
    try {
      const message = parseAnnotationServerMessage(JSON.parse(serialized))
      if (message.type !== 'rally_processing_update' || message.room_id !== roomId) return
      for (const listener of listeners.get(roomId) ?? []) listener(message)
    }
    catch { /* malformed ephemeral messages are dropped without touching domain state */ }
  })

  return {
    async publish(input) {
      const message = parseAnnotationServerMessage(input)
      if (message.type !== 'rally_processing_update') {
        throw new TypeError('AI progress message contract mismatch')
      }
      await redis.publish(channelFor(message.room_id), JSON.stringify(message))
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
