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
  if (input.state !== 'OPEN') return { enabled: false, reason: '尚未開始片段' }

  if (input.action.startsWith('close_')) {
    return input.confirmedLastKeyPointId
      ? { enabled: true, reason: '' }
      : { enabled: false, reason: '沒有可結束的擊球點' }
  }

  if (!input.canMark || !input.cursorCaptureTimeUs) return { enabled: false, reason: '游標尚未確認' }
  if (!input.serviceCaptureTimeUs || BigInt(input.cursorCaptureTimeUs) < BigInt(input.serviceCaptureTimeUs)) {
    return { enabled: false, reason: '游標位於目前片段開始之前' }
  }
  return { enabled: true, reason: '' }
}
