import { describe, expect, it } from 'vitest'
import { createAnnotationPresenceService, type PresenceRedisLike } from '../src/realtime/annotation-presence'

class MemorySubscriber {
  listener: ((pattern: string, channel: string, message: string) => void) | null = null
  async psubscribe() { return 1 }
  on(_event: 'pmessage', listener: (pattern: string, channel: string, message: string) => void) { this.listener = listener; return this }
  disconnect() {}
}
class MemoryRedis implements PresenceRedisLike {
  hashes = new Map<string, Record<string, string>>()
  subscriber = new MemorySubscriber()
  duplicate() { return this.subscriber }
  async hset(key: string, field: string, value: string) { this.hashes.set(key, { ...(this.hashes.get(key) ?? {}), [field]: value }); return 1 }
  async hget(key: string, field: string) { return this.hashes.get(key)?.[field] ?? null }
  async hgetall(key: string) { return { ...(this.hashes.get(key) ?? {}) } }
  async hdel(key: string, ...fields: string[]) { const value = this.hashes.get(key) ?? {}; for (const field of fields) delete value[field]; this.hashes.set(key, value); return fields.length }
  async expire() { return 1 }
  async publish(channel: string, message: string) { this.subscriber.listener?.('vmai:annotation:presence:events:*', channel, message); return 1 }
}

describe('annotation Redis presence', () => {
  it('publishes join/leave and expires stale device sessions', async () => {
    const roomId = 'match:00000000-0000-4000-8000-000000000001:capture:00000000-0000-4000-8000-000000000002'
    const redis = new MemoryRedis()
    let clock = new Date('2026-08-07T00:00:00.000Z')
    const presence = createAnnotationPresenceService({ redis, displayName: async () => 'Operator One', now: () => clock })
    let changes = 0
    await presence.subscribe(roomId, () => { changes += 1 })
    const member = await presence.join(roomId, { userId: 'user-1', deviceSessionId: 'device-1' })
    expect(member.display_name).toBe('Operator One')
    expect((await presence.snapshot(roomId)).members).toEqual([member])
    expect(changes).toBe(1)
    clock = new Date('2026-08-07T00:00:31.000Z')
    expect((await presence.snapshot(roomId)).members).toEqual([])
    await presence.leave(roomId, 'device-1')
    expect(changes).toBe(2)
    presence.close()
  })

  it('publishes a short edit hint, preserves it across presence touch, and expires it without removing the member', async () => {
    const roomId = 'match:00000000-0000-4000-8000-000000000001:capture:00000000-0000-4000-8000-000000000002'
    const redis = new MemoryRedis()
    let clock = new Date('2026-08-07T00:00:00.000Z')
    const presence = createAnnotationPresenceService({ redis, displayName: async () => 'Operator One', now: () => clock })
    let changes = 0
    await presence.subscribe(roomId, () => { changes += 1 })
    const member = await presence.join(roomId, { userId: 'user-1', deviceSessionId: 'device-1' })
    const editing = await presence.setEditing(roomId, member, 'key-point-1')
    expect((await presence.snapshot(roomId)).members[0]?.editing_key_point_id).toBe('key-point-1')
    await presence.touch(roomId, editing)
    expect((await presence.snapshot(roomId)).members[0]?.editing_key_point_id).toBe('key-point-1')

    clock = new Date('2026-08-07T00:00:12.001Z')
    expect(await presence.snapshot(roomId)).toMatchObject({
      members: [{ device_session_id: 'device-1', editing_key_point_id: null }],
    })
    expect(changes).toBe(2)

    const renewed = await presence.setEditing(roomId, editing, 'key-point-2')
    await presence.setEditing(roomId, renewed, null)
    expect((await presence.snapshot(roomId)).members[0]?.editing_key_point_id).toBeNull()
    expect(changes).toBe(4)
    presence.close()
  })
})
