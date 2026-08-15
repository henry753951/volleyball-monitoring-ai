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
