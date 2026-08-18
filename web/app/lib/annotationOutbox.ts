import { parseAnnotationCommand, type AnnotationCommand } from '@volleyball-monitoring/contracts'

export type AnnotationOutboxStatus = 'pending' | 'needs_confirmation'
export interface AnnotationOutboxEntry {
  command: AnnotationCommand
  queued_at: string
  status: AnnotationOutboxStatus
  reason: string | null
  observation?: {
    capture_time_us: string
    capture_frame_index: string | null
  }
  retry_count?: number
  attempted_at?: string
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const VERSION = 1
const MAX_ENTRIES = 256
const MAX_STORED_ENTRIES_TO_PARSE = 1024
const PREFIX = 'volleyball-monitoring-ai:annotation-outbox:1:'
const keyFor = (roomId: string) => `${PREFIX}${roomId}`

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function coalescingKey(entry: AnnotationOutboxEntry) {
  const command = entry.command
  const prefix = `${command.rally_id}:${command.kind}`
  if (command.kind === 'CREATE_CONTACT_KEY_POINT') {
    const frame = entry.observation?.capture_frame_index
    if (!frame) return null
    const event = command.payload.ball_event
    return `${prefix}:${frame}:${event?.kind ?? ''}:${event?.result ?? ''}:${command.payload.terminal_outcome ?? ''}`
  }
  if (command.kind === 'MOVE_KEY_POINT') return `${prefix}:${command.payload.key_point_id}`
  if (command.kind === 'SET_BALL_EVENT') return `${prefix}:${command.payload.key_point_id}`
  if (command.kind === 'SET_BALL_EVENT_ACTOR') return `${prefix}:${command.payload.key_point_id}`
  if (command.kind === 'DELETE_KEY_POINT') return `${prefix}:${command.payload.key_point_id}`
  if (
    [
      'START_RALLY',
      'CREATE_SERVICE_KEY_POINT',
      'END_RALLY',
      'CLOSE_RALLY',
      'SET_RALLY_OUTCOME',
      'REOPEN_RALLY',
      'VOID_RALLY',
      'SUBMIT_RALLY',
    ].includes(command.kind)
  )
    return prefix
  return null
}

/**
 * Keep the offline queue as a sequence of user intents, not raw key repeats.
 * Latest-wins edits replace an older queued edit while identical same-frame
 * contacts collapse to one command. Commands that exhausted reconciliation are
 * discarded so a stale sessionStorage queue cannot brick the next page load.
 */
export function compactAnnotationOutbox(entries: readonly AnnotationOutboxEntry[]) {
  const compacted: Array<AnnotationOutboxEntry | null> = []
  const indexByKey = new Map<string, number>()
  for (const entry of entries) {
    if ((entry.retry_count ?? 0) >= 3) continue
    const key = coalescingKey(entry)
    if (!key) {
      compacted.push(entry)
      continue
    }
    const previousIndex = indexByKey.get(key)
    if (previousIndex === undefined) {
      indexByKey.set(key, compacted.length)
      compacted.push(entry)
      continue
    }
    compacted[previousIndex] = null
    indexByKey.set(key, compacted.length)
    compacted.push(entry)
  }
  return compacted.filter(entry => entry !== null)
}

export function readAnnotationOutbox(
  storage: StorageLike,
  roomId: string,
): AnnotationOutboxEntry[] {
  const serialized = storage.getItem(keyFor(roomId))
  if (!serialized) return []
  try {
    const value: unknown = JSON.parse(serialized)
    if (!isRecord(value) || value.version !== VERSION || !Array.isArray(value.entries)) return []
    const parsed = value.entries.slice(-MAX_STORED_ENTRIES_TO_PARSE).map(item => {
      if (
        !isRecord(item) ||
        typeof item.queued_at !== 'string' ||
        Number.isNaN(Date.parse(item.queued_at)) ||
        !['pending', 'needs_confirmation'].includes(String(item.status)) ||
        (item.reason !== null && typeof item.reason !== 'string')
      )
        throw new TypeError('invalid outbox entry')
      const command = parseAnnotationCommand(item.command)
      if (command.room_id !== roomId) throw new TypeError('outbox room mismatch')
      const observation =
        isRecord(item.observation) &&
        typeof item.observation.capture_time_us === 'string' &&
        (item.observation.capture_frame_index === null ||
          typeof item.observation.capture_frame_index === 'string')
          ? {
              capture_time_us: item.observation.capture_time_us,
              capture_frame_index: item.observation.capture_frame_index as string | null,
            }
          : undefined
      const retry_count =
        typeof item.retry_count === 'number' &&
        Number.isInteger(item.retry_count) &&
        item.retry_count >= 0
          ? item.retry_count
          : undefined
      const attempted_at =
        typeof item.attempted_at === 'string' && !Number.isNaN(Date.parse(item.attempted_at))
          ? item.attempted_at
          : undefined
      return {
        command,
        queued_at: item.queued_at,
        status: item.status as AnnotationOutboxStatus,
        reason: item.reason,
        ...(observation ? { observation } : {}),
        ...(retry_count !== undefined ? { retry_count } : {}),
        ...(attempted_at ? { attempted_at } : {}),
      }
    })
    return compactAnnotationOutbox(parsed).slice(-MAX_ENTRIES)
  } catch {
    return []
  }
}

export function writeAnnotationOutbox(
  storage: StorageLike,
  roomId: string,
  entries: AnnotationOutboxEntry[],
) {
  if (!entries.length) {
    storage.removeItem(keyFor(roomId))
    return
  }
  storage.setItem(
    keyFor(roomId),
    JSON.stringify({ version: VERSION, entries: entries.slice(0, MAX_ENTRIES) }),
  )
}

export function enqueueAnnotationCommand(
  entries: AnnotationOutboxEntry[],
  command: AnnotationCommand,
  now = new Date(),
  metadata: Pick<AnnotationOutboxEntry, 'observation' | 'retry_count'> = {},
): AnnotationOutboxEntry[] {
  if (entries.some(entry => entry.command.command_id === command.command_id)) return [...entries]
  const compacted = compactAnnotationOutbox([
    ...entries,
    { command, queued_at: now.toISOString(), status: 'pending', reason: null, ...metadata },
  ])
  if (compacted.length > MAX_ENTRIES)
    throw new Error('本機待同步標註已達上限；請確認網路連線後再繼續')
  return compacted
}

export function replaceAnnotationOutboxCommand(
  entries: AnnotationOutboxEntry[],
  commandId: string,
  command: AnnotationCommand,
) {
  return entries.map(entry =>
    entry.command.command_id === commandId
      ? { ...entry, command, attempted_at: undefined, status: 'pending' as const, reason: null }
      : entry,
  )
}

/**
 * Commands may be queued against an optimistic key point before the CREATE
 * command receives its durable id. The outbox is strictly ordered, so rewrite
 * those dependencies as soon as the create acknowledgement arrives and keep
 * flushing without making the operator wait for a network round trip.
 */
export function resolveAnnotationOutboxKeyPointReference(
  entries: AnnotationOutboxEntry[],
  pendingKeyPointId: string,
  resolvedKeyPointId: string,
) {
  return entries.map(entry => {
    const { command } = entry
    switch (command.kind) {
      case 'MOVE_KEY_POINT':
      case 'SET_BALL_EVENT':
      case 'SET_BALL_EVENT_ACTOR':
      case 'DELETE_KEY_POINT':
        if (command.payload.key_point_id !== pendingKeyPointId) return entry
        return {
          ...entry,
          attempted_at: undefined,
          command: parseAnnotationCommand({
            ...command,
            payload: { ...command.payload, key_point_id: resolvedKeyPointId },
          }),
        }
      case 'CLOSE_RALLY':
        if (command.payload.target_key_point_id !== pendingKeyPointId) return entry
        return {
          ...entry,
          attempted_at: undefined,
          command: parseAnnotationCommand({
            ...command,
            payload: { ...command.payload, target_key_point_id: resolvedKeyPointId },
          }),
        }
      default:
        return entry
    }
  })
}

export function markAnnotationOutboxAttempted(
  entries: AnnotationOutboxEntry[],
  commandId: string,
  now = new Date(),
) {
  return entries.map(entry =>
    entry.command.command_id === commandId ? { ...entry, attempted_at: now.toISOString() } : entry,
  )
}

export function resolveAnnotationOutboxEntry(entries: AnnotationOutboxEntry[], commandId: string) {
  return entries.filter(entry => entry.command.command_id !== commandId)
}

export function requireAnnotationOutboxConfirmation(
  entries: AnnotationOutboxEntry[],
  commandId: string,
  reason: string,
) {
  return entries.map(entry =>
    entry.command.command_id === commandId
      ? { ...entry, status: 'needs_confirmation' as const, reason }
      : entry,
  )
}
