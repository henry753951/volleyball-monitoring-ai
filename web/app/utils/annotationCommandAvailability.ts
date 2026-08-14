import type { AnnotationAction } from './annotationHotkeys'

type DraftAction = Exclude<AnnotationAction, 'service' | 'submit'>
type AnnotationState = 'IDLE' | 'OPEN' | 'READY' | 'SUBMITTED' | 'VOIDED'

export interface DraftCommandAvailabilityInput {
  action: DraftAction
  state: AnnotationState
  canMark: boolean
  cursorCaptureTimeUs: string | null
  serviceCaptureTimeUs: string | null
  confirmedLastKeyPointId: string | null
}

export function draftCommandAvailability(input: DraftCommandAvailabilityInput) {
  if (input.action.startsWith('close_')) {
    return ['OPEN', 'READY'].includes(input.state)
      ? { enabled: true, reason: '' }
      : { enabled: false, reason: '目前沒有可設定結果的片段' }
  }

  if (input.state !== 'OPEN') return { enabled: false, reason: '尚未開始片段' }

  if (!input.canMark || !input.cursorCaptureTimeUs) return { enabled: false, reason: '游標尚未確認' }
  return { enabled: true, reason: '' }
}

export interface AnnotationSegmentRange {
  id: string
  startCaptureTimeUs: string
  endCaptureTimeUs: string
}

interface BoundaryCommandAvailabilityInput {
  state: string
  activeSubmissionId?: string | null
  canMark: boolean
  cursorCaptureTimeUs: string | null
  currentRallyId?: string | null
  startBoundaryCaptureTimeUs?: string | null
  currentDraftCaptureTimes?: readonly string[]
  clipPreRollUs: bigint
  clipPostRollUs: bigint
  segments: readonly AnnotationSegmentRange[]
}

function paddedRange(captureTimes: readonly string[], clipPreRollUs: bigint, clipPostRollUs: bigint) {
  if (!captureTimes.length) return null
  const ordered = captureTimes.map(BigInt).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  const requestedStart = ordered[0]! - clipPreRollUs
  const startCaptureTimeUs = requestedStart < 0n ? 0n : requestedStart
  const requestedEnd = ordered.at(-1)! + clipPostRollUs
  return {
    startCaptureTimeUs,
    endCaptureTimeUs: requestedEnd > startCaptureTimeUs ? requestedEnd : startCaptureTimeUs + 1n,
  }
}

function overlapsSegment(
  range: { startCaptureTimeUs: bigint; endCaptureTimeUs: bigint },
  segments: readonly AnnotationSegmentRange[],
  excludedRallyId?: string | null,
) {
  return segments.some(segment => segment.id !== excludedRallyId
    && range.startCaptureTimeUs < BigInt(segment.endCaptureTimeUs)
    && range.endCaptureTimeUs > BigInt(segment.startCaptureTimeUs))
}

export function boundaryCommandAvailability(input: BoundaryCommandAvailabilityInput) {
  if (!input.canMark || !input.cursorCaptureTimeUs) {
    return { enabled: false, reason: '播放游標尚未確認' }
  }

  const isOrdinaryOpenDraft = input.state === 'OPEN' && !input.activeSubmissionId
  if (isOrdinaryOpenDraft) {
    const startCaptureTimeUs = input.startBoundaryCaptureTimeUs
    if (!startCaptureTimeUs) return { enabled: false, reason: '目前片段缺少開始邊界' }
    if (BigInt(input.cursorCaptureTimeUs) <= BigInt(startCaptureTimeUs)) {
      return { enabled: false, reason: '請將游標移到片段開始之後再結束' }
    }
    const range = paddedRange(
      [...(input.currentDraftCaptureTimes ?? []), input.cursorCaptureTimeUs],
      input.clipPreRollUs,
      input.clipPostRollUs,
    )
    if (range && overlapsSegment(range, input.segments, input.currentRallyId)) {
      return { enabled: false, reason: '片段結束位置會與其他片段重疊' }
    }
    return { enabled: true, reason: '再次按 Z，以目前畫面作為片段結束' }
  }

  if (openDraftBlocksNewRally(input.state, input.activeSubmissionId)) {
    return { enabled: false, reason: '目前仍有正在編輯的片段' }
  }
  const range = paddedRange([input.cursorCaptureTimeUs], input.clipPreRollUs, input.clipPostRollUs)
  if (range && overlapsSegment(range, input.segments)) {
    return { enabled: false, reason: '目前位置位於既有片段內' }
  }
  return { enabled: true, reason: '' }
}

export function openDraftBlocksNewRally(
  state: string,
  activeSubmissionId: string | null | undefined,
) {
  // A correction draft keeps an immutable active submission attached to the
  // Rally. The backend intentionally allows that draft to coexist with a new
  // Rally; only an unsent, submission-less draft owns the new-service slot.
  return state === 'OPEN' && !activeSubmissionId
}
