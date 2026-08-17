import { describe, expect, it } from 'vitest'
import { coachHighlightFingerprint } from './coachHighlightFingerprint'

const event = {
  event_id: 'run:key-point:4',
  rally_id: '1c788bfd-82ba-48b9-b13e-1b18cef2b443',
  clip_job_id: '80107988-f672-4e5f-bcc1-ea3c84a8a380',
  clip_duration_us: '2871333',
  anchor_time_us: '800000',
  set_number: 1,
  rally_ordinal: 1,
  action_key: 'serve',
  action_label: '發球',
}

describe('coachHighlightFingerprint', () => {
  it('is stable for the same analytics source version', async () => {
    const input = { subjectLabel: 'Iran', filterLabel: '全部球種', events: [event] }
    expect(await coachHighlightFingerprint(input)).toBe(await coachHighlightFingerprint(input))
  })

  it('changes when new analytics events arrive', async () => {
    const before = await coachHighlightFingerprint({
      subjectLabel: 'Iran',
      filterLabel: '全部球種',
      events: [event],
    })
    const after = await coachHighlightFingerprint({
      subjectLabel: 'Iran',
      filterLabel: '全部球種',
      events: [event, { ...event, event_id: 'run:key-point:5', action_label: '殺球' }],
    })
    expect(after).not.toBe(before)
  })
})
