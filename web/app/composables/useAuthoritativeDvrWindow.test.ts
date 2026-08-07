import { describe, expect, it } from 'vitest'
import { frameRecovery } from './useAuthoritativeDvrWindow'

describe('authoritative DVR recovery classification', () => {
  it.each([
    ['WINDOW_BOUNDARY', 'recenter'],
    ['WINDOW_EXPIRED', 'refresh'],
    ['MAPPING_STALE', 'refresh'],
    ['SAMPLE_NOT_FOUND', 'blocked'],
    ['CAPTURE_GAP', 'blocked'],
    ['UNKNOWN', 'error'],
  ])('%s remains typed and non-optimistic', (code, expected) => {
    expect(frameRecovery(code)).toBe(expected)
  })
})
