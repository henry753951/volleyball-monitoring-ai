import { describe, expect, it } from 'vitest'
import { omeRecordingStartTime } from '../src/media/prisma-ingest-repository.js'

describe('OME recording extent start time', () => {
  it('parses the configured UTC OME filename without using recording.xml startTime', () => {
    expect(omeRecordingStartTime('youtube-live/20260818070116_0.mp4')?.toISOString()).toBe(
      '2026-08-18T07:01:16.000Z',
    )
  })

  it('rejects paths that do not follow the configured OME recording map', () => {
    expect(omeRecordingStartTime('youtube-live/segment-1.mp4')).toBeNull()
  })
})
