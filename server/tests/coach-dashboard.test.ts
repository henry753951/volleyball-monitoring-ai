import { describe, expect, it } from 'vitest'
import { deriveRallyDisplayOrdinals, segmentStartCaptureTimeUs } from '../src/domain/rally-display-order.js'
import { selectDisplayAnalysis } from '../src/services/coach-dashboard.js'

describe('coach dashboard analysis failover', () => {
  const previous = { id: 'previous', status: 'COMPLETED' }

  it('keeps the previous completed analysis while the replacement is unfinished', () => {
    expect(selectDisplayAnalysis({ id: 'replacement', status: 'RUNNING' }, previous)).toEqual({
      analysis: previous,
      source: 'previous',
    })
  })

  it('switches to the replacement only after it completes', () => {
    const replacement = { id: 'replacement', status: 'COMPLETED' }
    expect(selectDisplayAnalysis(replacement, previous)).toEqual({
      analysis: replacement,
      source: 'current',
    })
  })

  it('does not expose an unfinished first analysis', () => {
    expect(selectDisplayAnalysis({ id: 'first', status: 'FAILED' }, null)).toEqual({
      analysis: null,
      source: null,
    })
  })
})

describe('derived rally display order', () => {
  it('uses the START boundary rather than stored or legacy naming state', () => {
    expect(segmentStartCaptureTimeUs({
      boundaries: [{ captureTimeUs: 5_000_000n, kind: 'START' }],
      keyPoints: [{ captureTimeUs: 1_000_000n, markerKind: 'SERVICE' }],
    })).toBe(5_000_000n)
  })

  it('numbers each set by capture order and closes gaps without persisted ordinals', () => {
    const ordinals = deriveRallyDisplayOrdinals([
      { id: 'later', displaySetNumber: 1, startCaptureTimeUs: 9_000_000n },
      { id: 'only-in-set-two', displaySetNumber: 2, startCaptureTimeUs: 2_000_000n },
      { id: 'earlier', displaySetNumber: 1, startCaptureTimeUs: 3_000_000n },
    ])
    expect(Object.fromEntries(ordinals)).toEqual({
      earlier: 1,
      later: 2,
      'only-in-set-two': 1,
    })
  })
})
