import { parseAnnotationServerMessage, type AnnotationPresenceSnapshot } from '@volleyball-monitoring/contracts'

type PresenceMember = AnnotationPresenceSnapshot['members'][number]
interface StoredPresenceMember extends PresenceMember { expires_at: string }
interface RedisSubscriberLike {
  psubscribe(pattern: string): Promise<unknown>
  on(event: 'pmessage', listener: (pattern: string, channel: string, message: string) => void): this
  disconnect(): void
}
export interface PresenceRedisLike {
  duplicate(): RedisSubscriberLike
  hset(key: string, field: string, value: string): Promise<number>
  hgetall(key: string): Promise<Record<string, string>>
  hdel(key: string, ...fields: string[]): Promise<number>
  expire(key: string, seconds: number): Promise<number>
  publish(channel: string, message: string): Promise<number>
}

export interface AnnotationPresenceService {
  join(roomId: string, identity: { userId: string; deviceSessionId: string }): Promise<PresenceMember>
  touch(roomId: string, member: PresenceMember): Promise<void>
  leave(roomId: string, deviceSessionId: string): Promise<void>
  snapshot(roomId: string): Promise<AnnotationPresenceSnapshot>
  subscribe(roomId: string, listener: () => void): Promise<() => void>
  close(): void
}

const HASH_PREFIX = 'vmai:annotation:presence:v2:'
const CHANNEL_PREFIX = 'vmai:annotation:presence:events:'
const PRESENCE_TTL_MS = 30_000
const keyFor = (roomId: string) => `${HASH_PREFIX}${roomId}`
const channelFor = (roomId: string) => `${CHANNEL_PREFIX}${roomId}`

export function createAnnotationPresenceService(deps: {
  redis: PresenceRedisLike
  displayName: (userId: string) => Promise<string | null>
  now?: () => Date
}): AnnotationPresenceService {
  const now = deps.now ?? (() => new Date())
  const subscriber = deps.redis.duplicate()
  const listeners = new Map<string, Set<() => void>>()
  let subscribeStarted: Promise<void> | null = null
  subscriber.on('pmessage', (_pattern, channel) => {
    if (!channel.startsWith(CHANNEL_PREFIX)) return
    const roomId = channel.slice(CHANNEL_PREFIX.length)
    for (const listener of listeners.get(roomId) ?? []) listener()
  })

  const publish = async (roomId: string) => { await deps.redis.publish(channelFor(roomId), 'changed') }
  const store = async (roomId: string, member: PresenceMember) => {
    const expiresAt = new Date(now().getTime() + PRESENCE_TTL_MS).toISOString()
    await deps.redis.hset(keyFor(roomId), member.device_session_id, JSON.stringify({ ...member, expires_at: expiresAt } satisfies StoredPresenceMember))
    await deps.redis.expire(keyFor(roomId), Math.ceil(PRESENCE_TTL_MS / 1_000) * 2)
  }

  return {
    async join(roomId, identity) {
      const member: PresenceMember = {
        user_id: identity.userId,
        device_session_id: identity.deviceSessionId,
        display_name: await deps.displayName(identity.userId) ?? identity.userId,
        editing_key_point_id: null,
      }
      await store(roomId, member)
      await publish(roomId)
      return member
    },
    async touch(roomId, member) { await store(roomId, member) },
    async leave(roomId, deviceSessionId) {
      await deps.redis.hdel(keyFor(roomId), deviceSessionId)
      await publish(roomId)
    },
    async snapshot(roomId) {
      const values = await deps.redis.hgetall(keyFor(roomId))
      const members: PresenceMember[] = []
      const expired: string[] = []
      const currentTime = now().getTime()
      for (const [deviceSessionId, serialized] of Object.entries(values)) {
        try {
          const value = JSON.parse(serialized) as Partial<StoredPresenceMember>
          if (typeof value.expires_at !== 'string' || Date.parse(value.expires_at) <= currentTime) { expired.push(deviceSessionId); continue }
          if (typeof value.user_id !== 'string' || typeof value.device_session_id !== 'string' || typeof value.display_name !== 'string' || value.device_session_id !== deviceSessionId) { expired.push(deviceSessionId); continue }
          members.push({ user_id: value.user_id, device_session_id: value.device_session_id, display_name: value.display_name, editing_key_point_id: typeof value.editing_key_point_id === 'string' ? value.editing_key_point_id : null })
        }
        catch { expired.push(deviceSessionId) }
      }
      if (expired.length) await deps.redis.hdel(keyFor(roomId), ...expired)
      members.sort((left, right) => left.display_name.localeCompare(right.display_name) || left.device_session_id.localeCompare(right.device_session_id))
      const message = parseAnnotationServerMessage({ schema_version: '2.0.0', type: 'presence_snapshot', room_id: roomId, members })
      if (message.type !== 'presence_snapshot') throw new TypeError('presence snapshot contract mismatch')
      return message
    },
    async subscribe(roomId, listener) {
      if (!subscribeStarted) subscribeStarted = subscriber.psubscribe(`${CHANNEL_PREFIX}*`).then(() => undefined)
      await subscribeStarted
      const roomListeners = listeners.get(roomId) ?? new Set<() => void>()
      roomListeners.add(listener)
      listeners.set(roomId, roomListeners)
      return () => {
        roomListeners.delete(listener)
        if (!roomListeners.size) listeners.delete(roomId)
      }
    },
    close() { listeners.clear(); subscriber.disconnect() },
  }
}
