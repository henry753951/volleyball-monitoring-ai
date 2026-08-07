import { parseAnnotationCommand, type AnnotationCommand } from '@volleyball-monitoring/contracts'

export type AnnotationOutboxStatus = 'pending' | 'needs_confirmation'
export interface AnnotationOutboxEntry {
  command: AnnotationCommand
  queued_at: string
  status: AnnotationOutboxStatus
  reason: string | null
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const VERSION = 1
const MAX_ENTRIES = 32
const PREFIX = 'volleyball-monitoring-ai:annotation-outbox:1:'
const keyFor = (roomId: string) => `${PREFIX}${roomId}`

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function readAnnotationOutbox(storage: StorageLike, roomId: string): AnnotationOutboxEntry[] {
  const serialized = storage.getItem(keyFor(roomId))
  if (!serialized) return []
  try {
    const value: unknown = JSON.parse(serialized)
    if (!isRecord(value) || value.version !== VERSION || !Array.isArray(value.entries)) return []
    return value.entries.slice(0, MAX_ENTRIES).map((item) => {
      if (!isRecord(item) || typeof item.queued_at !== 'string' || Number.isNaN(Date.parse(item.queued_at)) || !['pending', 'needs_confirmation'].includes(String(item.status)) || (item.reason !== null && typeof item.reason !== 'string')) throw new TypeError('invalid outbox entry')
      const command = parseAnnotationCommand(item.command)
      if (command.room_id !== roomId) throw new TypeError('outbox room mismatch')
      return { command, queued_at: item.queued_at, status: item.status as AnnotationOutboxStatus, reason: item.reason }
    })
  }
  catch {
    return []
  }
}

export function writeAnnotationOutbox(storage: StorageLike, roomId: string, entries: AnnotationOutboxEntry[]) {
  if (!entries.length) { storage.removeItem(keyFor(roomId)); return }
  storage.setItem(keyFor(roomId), JSON.stringify({ version: VERSION, entries: entries.slice(0, MAX_ENTRIES) }))
}

export function enqueueAnnotationCommand(entries: AnnotationOutboxEntry[], command: AnnotationCommand, now = new Date()): AnnotationOutboxEntry[] {
  if (entries.some(entry => entry.command.command_id === command.command_id)) return entries
  if (entries.length >= MAX_ENTRIES) throw new Error('Annotation local outbox is full')
  return [...entries, { command, queued_at: now.toISOString(), status: 'pending', reason: null }]
}

export function resolveAnnotationOutboxEntry(entries: AnnotationOutboxEntry[], commandId: string) {
  return entries.filter(entry => entry.command.command_id !== commandId)
}

export function requireAnnotationOutboxConfirmation(entries: AnnotationOutboxEntry[], commandId: string, reason: string) {
  return entries.map(entry => entry.command.command_id === commandId ? { ...entry, status: 'needs_confirmation' as const, reason } : entry)
}
