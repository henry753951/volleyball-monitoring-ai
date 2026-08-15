import { describe, expect, it } from 'vitest'
import {
  enqueueAnnotationCommand,
  markAnnotationOutboxAttempted,
  readAnnotationOutbox,
  requireAnnotationOutboxConfirmation,
  resolveAnnotationOutboxEntry,
  writeAnnotationOutbox,
} from './annotationOutbox'

const room =
  'match:00000000-0000-4000-8000-000000000001:capture:00000000-0000-4000-8000-000000000002'
const command = {
  schema_version: '2.0.0',
  command_id: '00000000-0000-4000-8000-000000000003',
  room_id: room,
  base_revision: '0',
  rally_id: '00000000-0000-4000-8000-000000000004',
  kind: 'CREATE_SERVICE_KEY_POINT',
  payload: {
    playback_cursor: {
      playback_window_id: 'window-1',
      mapping_version: 1,
      player_media_time_us: '0',
      observation_source: 'current_time_fallback',
      presented_frames: null,
      seek_generation: 0,
      cursor_status: 'ready',
    },
  },
} as const
class MemoryStorage {
  value = new Map<string, string>()
  getItem(key: string) {
    return this.value.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.value.set(key, value)
  }
  removeItem(key: string) {
    this.value.delete(key)
  }
}

describe('annotation local outbox', () => {
  it('round-trips a strict command without duplicating its command id', () => {
    const storage = new MemoryStorage()
    const entries = enqueueAnnotationCommand([], command, new Date('2026-08-07T00:00:00.000Z'))
    writeAnnotationOutbox(storage, room, enqueueAnnotationCommand(entries, command))
    expect(readAnnotationOutbox(storage, room)).toEqual(entries)
  })
  it('marks conflicts for confirmation and removes acknowledged entries', () => {
    const entries = enqueueAnnotationCommand([], command)
    expect(
      requireAnnotationOutboxConfirmation(entries, command.command_id, 'revision changed')[0],
    ).toMatchObject({ status: 'needs_confirmation', reason: 'revision changed' })
    expect(resolveAnnotationOutboxEntry(entries, command.command_id)).toEqual([])
  })
  it('persists whether an idempotent command may already have reached the server', () => {
    const storage = new MemoryStorage()
    const attempted = markAnnotationOutboxAttempted(
      enqueueAnnotationCommand([], command),
      command.command_id,
      new Date('2026-08-14T00:00:00.000Z'),
    )
    writeAnnotationOutbox(storage, room, attempted)
    expect(readAnnotationOutbox(storage, room)[0]?.attempted_at).toBe('2026-08-14T00:00:00.000Z')
  })
  it('fails closed on malformed or cross-room storage', () => {
    const storage = new MemoryStorage()
    storage.setItem(
      `volleyball-monitoring-ai:annotation-outbox:1:${room}`,
      JSON.stringify({
        version: 1,
        entries: [
          {
            command: { ...command, room_id: `${room}-other` },
            queued_at: new Date().toISOString(),
            status: 'pending',
            reason: null,
          },
        ],
      }),
    )
    expect(readAnnotationOutbox(storage, room)).toEqual([])
  })
})
