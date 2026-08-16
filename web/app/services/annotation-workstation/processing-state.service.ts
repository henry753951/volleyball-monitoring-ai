import type { AnnotationRallyProcessingUpdate } from '@volleyball-monitoring/contracts'

function terminal(update: AnnotationRallyProcessingUpdate) {
  return update.processing_status === 'completed' || update.processing_status === 'failed'
}

function updatedAt(update: AnnotationRallyProcessingUpdate) {
  const value = Date.parse(update.updated_at ?? '')
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY
}

/**
 * Merges the query-backed processing projection with a realtime observation.
 * A terminal projection for the same immutable submission is monotonic: a
 * delayed or locally cached non-terminal event can never reopen it. A newer
 * submission remains allowed to replace the previous terminal projection.
 */
export function mergeRallyProcessingUpdate(
  authoritative: AnnotationRallyProcessingUpdate | null | undefined,
  realtime: AnnotationRallyProcessingUpdate | null | undefined,
) {
  if (!authoritative) return realtime ?? null
  if (!realtime) return authoritative

  if (authoritative.submission_id === realtime.submission_id) {
    if (terminal(authoritative) && !terminal(realtime)) return authoritative
    if (terminal(realtime) && !terminal(authoritative)) return realtime
  }

  return updatedAt(realtime) > updatedAt(authoritative) ? realtime : authoritative
}
