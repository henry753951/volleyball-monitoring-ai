import { describe, expect, it } from 'vitest'
import {
  adjacentAnnotationKeyPoint,
  isSupersededSourceSubmission,
  type NavigableAnnotationKeyPoint,
} from './annotationKeyPointNavigation'

const points: NavigableAnnotationKeyPoint[] = [
  { id: 'a', captureTimeUs: '100', rallyId: 'rally-a', editable: false },
  { id: 'b', captureTimeUs: '200', rallyId: 'rally-b', editable: true },
  { id: 'c', captureTimeUs: '300', rallyId: 'rally-c', editable: true },
]

describe('annotation key-point navigation', () => {
  it('identifies the immutable source points replaced by a correction draft', () => {
    expect(
      isSupersededSourceSubmission({
        activeSubmissionId: 'submission-a',
        currentRallyId: 'correction-rally',
        rallyId: 'source-rally',
        submissionId: 'submission-a',
      }),
    ).toBe(true)
    expect(
      isSupersededSourceSubmission({
        activeSubmissionId: 'submission-a',
        currentRallyId: 'source-rally',
        rallyId: 'source-rally',
        submissionId: 'submission-a',
      }),
    ).toBe(false)
  })

  it('advances from its local selection instead of a cursor changed by async loading', () => {
    expect(
      adjacentAnnotationKeyPoint(points, {
        direction: 'next',
        selectedId: 'b',
        referenceCaptureTimeUs: '999',
      })?.id,
    ).toBe('c')
  })

  it('uses capture time only when no point is selected', () => {
    expect(
      adjacentAnnotationKeyPoint(points, {
        direction: 'previous',
        selectedId: null,
        referenceCaptureTimeUs: '250',
      })?.id,
    ).toBe('b')
  })

  it('crosses rally boundaries using the globally ordered local point list', () => {
    expect(
      adjacentAnnotationKeyPoint(points, {
        direction: 'previous',
        selectedId: 'b',
        referenceCaptureTimeUs: '999',
      }),
    ).toMatchObject({ id: 'a', rallyId: 'rally-a' })
  })

  it('stays at a global boundary instead of wrapping or seeking elsewhere', () => {
    expect(
      adjacentAnnotationKeyPoint(points, {
        direction: 'previous',
        selectedId: 'a',
        referenceCaptureTimeUs: '999',
      }),
    ).toBeNull()
    expect(
      adjacentAnnotationKeyPoint(points, {
        direction: 'next',
        selectedId: 'c',
        referenceCaptureTimeUs: '0',
      }),
    ).toBeNull()
  })
})
