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

  it('allows X after the service point without using the rendered mask end as a boundary', () => {
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

  it('blocks X before service and close actions without a confirmed target', () => {
    expect(draftCommandAvailability({
      ...openDraft,
      action: 'contact',
      cursorCaptureTimeUs: '9000000',
    }).enabled).toBe(false)
    expect(draftCommandAvailability({
      ...openDraft,
      action: 'close_left',
      confirmedLastKeyPointId: null,
    }).enabled).toBe(false)
  })

  it('blocks contact edits but keeps outcome selection available after Z closes the rally', () => {
    expect(draftCommandAvailability({ ...openDraft, action: 'contact', state: 'READY' }).enabled).toBe(false)
    expect(draftCommandAvailability({ ...openDraft, action: 'close_right', state: 'READY' })).toEqual({ enabled: true, reason: '' })
  })
})
