import { describe, expect, it } from 'vitest'
import { draftCommandAvailability } from './annotationCommandAvailability'

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
