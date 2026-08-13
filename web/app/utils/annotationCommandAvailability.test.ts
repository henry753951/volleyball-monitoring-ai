import { describe, expect, it } from 'vitest'
import { draftCommandAvailability, openDraftBlocksNewRally } from './annotationCommandAvailability'

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

  it('blocks contact edits but keeps outcome selection available after Z closes the rally', () => {
    expect(draftCommandAvailability({ ...openDraft, action: 'contact', state: 'READY' }).enabled).toBe(false)
    expect(draftCommandAvailability({ ...openDraft, action: 'close_right', state: 'READY' })).toEqual({ enabled: true, reason: '' })
  })
})
