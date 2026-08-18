const ACTIVE_RALLY_PROCESSING_STATUSES = new Set([
  'clip_queued',
  'clipping',
  'ai_queued',
  'ai_processing',
  'artifact_ingesting',
])

const ACTIVE_CAPTURE_STATUSES = new Set(['STARTING', 'LIVE', 'STOPPING'])

export function captureNeedsPolling(status: string | null | undefined) {
  return Boolean(status && ACTIVE_CAPTURE_STATUSES.has(status.toUpperCase()))
}

export function hasActiveRallyProcessing(
  rallies: ReadonlyArray<{ processing_status: string }> | null | undefined,
) {
  return Boolean(
    rallies?.some(rally => ACTIVE_RALLY_PROCESSING_STATUSES.has(rally.processing_status)),
  )
}

export type CapturePollOutcome = 'changed' | 'unchanged' | 'failed' | 'skipped'

export function nextCapturePollDelay(
  currentDelayMs: number,
  outcome: CapturePollOutcome,
  online = true,
): number {
  if (!online || outcome === 'skipped') return 5_000
  if (outcome === 'changed') return 1_000
  if (outcome === 'failed') {
    return Math.min(15_000, Math.max(2_500, Math.round(currentDelayMs * 1.8)))
  }
  return Math.min(5_000, Math.max(2_500, Math.round(currentDelayMs * 1.35)))
}
