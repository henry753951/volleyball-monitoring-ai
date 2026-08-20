import { describe, expect, it } from 'vitest'
import { segmentStartCaptureTimeUs } from '../src/domain/rally-display-order.js'
import { selectDisplayAnalysis } from '../src/services/coach-dashboard.js'
import { resolveEffectiveContactFrame } from '../src/services/effective-contact-frame.js'

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

  it('projects an explicitly reused analysis before walking predecessor history', () => {
    const reused = { id: 'reused', status: 'COMPLETED' }
    expect(
      selectDisplayAnalysis({ id: 'replacement', status: 'RUNNING' }, previous, reused),
    ).toEqual({
      analysis: reused,
      source: 'reused',
    })
  })

  it('does not expose an unfinished first analysis', () => {
    expect(selectDisplayAnalysis({ id: 'first', status: 'FAILED' }, null)).toEqual({
      analysis: null,
      source: null,
    })
  })
})

describe('effective contact frame projection', () => {
  const event = {
    keyPointId: 'contact-1',
    anchorFrameIndex: 72n,
    resolvedFrameIndex: 75n,
  }

  it('uses the persisted resolved frame when no human correction exists', () => {
    expect(resolveEffectiveContactFrame(event, new Map())).toBe(75n)
  })

  it('uses a human correction before the resolved and anchor frames', () => {
    expect(resolveEffectiveContactFrame(event, new Map([['contact-1', 79n]]))).toBe(79n)
  })

  it('falls back to the original anchor when analysis has no resolved frame', () => {
    expect(resolveEffectiveContactFrame({ ...event, resolvedFrameIndex: null }, new Map())).toBe(
      72n,
    )
  })
})

describe('derived rally display order', () => {
  it('uses the START boundary rather than stored or legacy naming state', () => {
    expect(
      segmentStartCaptureTimeUs({
        boundaries: [{ captureTimeUs: 5_000_000n, kind: 'START' }],
        keyPoints: [{ captureTimeUs: 1_000_000n, markerKind: 'SERVICE' }],
      }),
    ).toBe(5_000_000n)
  })
})
