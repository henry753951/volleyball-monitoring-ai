import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MEDIA_BUFFER_PRESET,
  parseMediaBufferPreset,
  serializeMediaBufferPreset,
} from './mediaPlaybackPreferences'

describe('media playback preferences', () => {
  it('round-trips a supported buffer preset', () => {
    expect(parseMediaBufferPreset(serializeMediaBufferPreset('large'))).toBe('large')
  })

  it('rejects malformed and unknown stored values', () => {
    expect(parseMediaBufferPreset('{broken')).toBeNull()
    expect(parseMediaBufferPreset(JSON.stringify({ version: 1, bufferPreset: 'unbounded' }))).toBeNull()
    expect(DEFAULT_MEDIA_BUFFER_PRESET).toBe('balanced')
  })
})
