import { describe, expect, it } from 'vitest'
import {
  adjacentAnnotationKeyPoint,
  type NavigableAnnotationKeyPoint,
} from './annotationKeyPointNavigation'

const points: NavigableAnnotationKeyPoint[] = [
  { id: 'a', captureTimeUs: '100', rallyId: 'rally-a', editable: false },
  { id: 'b', captureTimeUs: '200', rallyId: 'rally-b', editable: true },
  { id: 'c', captureTimeUs: '300', rallyId: 'rally-c', editable: true },
]

describe('annotation key-point navigation', () => {
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
})
