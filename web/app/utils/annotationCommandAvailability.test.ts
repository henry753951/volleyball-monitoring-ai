import { describe, expect, it } from 'vitest'
import {
  boundaryCommandAvailability,
  draftCommandAvailability,
} from './annotationCommandAvailability'

const base = {
  action: 'contact' as const,
  state: 'OPEN' as const,
  canMark: true,
  cursorCaptureTimeUs: '150',
  serviceCaptureTimeUs: '100',
  editableStartCaptureTimeUs: '100',
  editableEndCaptureTimeUs: '200',
  confirmedLastKeyPointId: null,
}

describe('draftCommandAvailability', () => {
  it('allows a point only inside the editable rally interval', () => {
    expect(draftCommandAvailability(base)).toEqual({ enabled: true, reason: '' })
    expect(draftCommandAvailability({ ...base, cursorCaptureTimeUs: '99' })).toMatchObject({
      enabled: false,
      reason: '目前畫格不在可編輯片段內',
    })
    expect(draftCommandAvailability({ ...base, cursorCaptureTimeUs: '201' })).toMatchObject({
      enabled: false,
      reason: '目前畫格不在可編輯片段內',
    })
  })

  it('keeps rally outcome commands independent from the cursor interval', () => {
    expect(
      draftCommandAvailability({
        ...base,
        action: 'close_left',
        cursorCaptureTimeUs: '999',
      }),
    ).toEqual({ enabled: true, reason: '' })
  })
})

describe('boundaryCommandAvailability', () => {
  const boundaryBase = {
    activeSubmissionId: null,
    canMark: true,
    cursorCaptureTimeUs: '150',
    currentRallyId: 'draft',
    startBoundaryCaptureTimeUs: '100',
    currentDraftCaptureTimes: ['100', '140'],
    clipPreRollUs: 0n,
    clipPostRollUs: 0n,
    segments: [],
  }

  it('allows Z to end an owned OPEN draft', () => {
    expect(boundaryCommandAvailability({ ...boundaryBase, state: 'OPEN' })).toMatchObject({
      enabled: true,
    })
  })

  it('keeps Z disabled after END while the ordinary draft is READY', () => {
    expect(boundaryCommandAvailability({ ...boundaryBase, state: 'READY' })).toEqual({
      enabled: false,
      reason: '目前仍有正在編輯的片段',
    })
  })
})
