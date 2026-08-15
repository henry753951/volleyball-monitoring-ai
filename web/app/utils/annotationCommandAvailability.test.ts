import { describe, expect, it } from 'vitest'
import { boundaryCommandAvailability, draftCommandAvailability, openDraftBlocksNewRally } from './annotationCommandAvailability'

const openDraft = {
  state: 'OPEN' as const,
  canMark: true,
  cursorCaptureTimeUs: '30000000',
  serviceCaptureTimeUs: '10000000',
  confirmedLastKeyPointId: 'key-point-1',
}

describe('draft annotation command availability', () => {
  it('allows a new Rally while an existing Rally is open only as a correction draft', () => {
    expect(openDraftBlocksNewRally('OPEN', 'active-submission')).toBe(false)
    expect(openDraftBlocksNewRally('OPEN', null)).toBe(true)
    expect(openDraftBlocksNewRally('SUBMITTED', 'active-submission')).toBe(false)
  })

  it('allows X while a segment is open without using the rendered mask as a hard boundary', () => {
    expect(draftCommandAvailability({ ...openDraft, action: 'contact' })).toEqual({ enabled: true, reason: '' })
  })

  it.each(['close_left', 'close_right', 'close_unknown'] as const)(
    'allows %s from the server-confirmed last point even when the media cursor is unavailable',
    (action) => {
      expect(draftCommandAvailability({
        ...openDraft,
        action,
        canMark: false,
        cursorCaptureTimeUs: null,
      })).toEqual({ enabled: true, reason: '' })
    },
  )

  it('allows X outside the visible segment and outcome selection without a confirmed contact', () => {
    expect(draftCommandAvailability({
      ...openDraft,
      action: 'contact',
      cursorCaptureTimeUs: '9000000',
    })).toEqual({ enabled: true, reason: '' })
    expect(draftCommandAvailability({
      ...openDraft,
      action: 'close_left',
      confirmedLastKeyPointId: null,
    })).toEqual({ enabled: true, reason: '' })
  })

  it('keeps contact edits and outcome selection available after Z fixes the end boundary', () => {
    expect(draftCommandAvailability({ ...openDraft, action: 'contact', state: 'READY' })).toEqual({ enabled: true, reason: '' })
    expect(draftCommandAvailability({ ...openDraft, action: 'close_right', state: 'READY' })).toEqual({ enabled: true, reason: '' })
  })
})

describe('boundary annotation command availability', () => {
  const segment = { id: 'existing', startCaptureTimeUs: '20000000', endCaptureTimeUs: '30000000' }

  it('blocks starting a segment from inside an existing segment', () => {
    expect(boundaryCommandAvailability({
      state: 'IDLE', canMark: true, cursorCaptureTimeUs: '25000000',
      clipPreRollUs: 0n, clipPostRollUs: 0n, segments: [segment],
    })).toEqual({ enabled: false, reason: '目前位置位於既有片段內' })
  })

  it('blocks an end boundary when the resulting draft would overlap another segment', () => {
    expect(boundaryCommandAvailability({
      state: 'OPEN', activeSubmissionId: null, canMark: true,
      cursorCaptureTimeUs: '25000000', currentRallyId: 'draft',
      startBoundaryCaptureTimeUs: '10000000',
      currentDraftCaptureTimes: ['10000000'], clipPreRollUs: 0n, clipPostRollUs: 0n,
      segments: [segment, { id: 'draft', startCaptureTimeUs: '10000000', endCaptureTimeUs: '25000000' }],
    })).toEqual({ enabled: false, reason: '片段結束位置會與其他片段重疊' })
  })

  it('allows a correction draft to coexist with a new non-overlapping segment', () => {
    expect(boundaryCommandAvailability({
      state: 'OPEN', activeSubmissionId: 'submission', canMark: true,
      cursorCaptureTimeUs: '40000000', currentRallyId: 'correction',
      currentDraftCaptureTimes: ['20000000', '30000000'], clipPreRollUs: 0n, clipPostRollUs: 0n,
      segments: [segment],
    })).toEqual({ enabled: true, reason: '' })
  })
})
