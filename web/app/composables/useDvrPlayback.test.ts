import { describe, expect, it } from 'vitest'
import { boundedPlayerMediaSeconds } from '../utils/playerMediaTime'
import { requiresPlaybackPipelineReplacement } from './useDvrPlayback'
describe('bounded player media time', () => {
  it('does not subtract canonical presentation origin', () => {
    expect(boundedPlayerMediaSeconds('120000000')).toBe(120)
  })
  it('rejects negative or unbounded local values', () => {
    expect(() => boundedPlayerMediaSeconds('-1')).toThrow(RangeError)
    expect(() => boundedPlayerMediaSeconds('9007199254740992')).toThrow(RangeError)
  })
})

describe('rolling HLS attachment', () => {
  it('keeps one MSE pipeline for mapping revisions of the same window', () => {
    expect(requiresPlaybackPipelineReplacement(
      { playback_window_id: 'window-a' },
      { playback_window_id: 'window-a' },
    )).toBe(false)
    expect(requiresPlaybackPipelineReplacement(
      { playback_window_id: 'window-a' },
      { playback_window_id: 'window-b' },
    )).toBe(true)
  })
})
