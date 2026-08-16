export interface NavigableAnnotationKeyPoint {
  id: string
  captureTimeUs: string
  rallyId: string | null
  editable: boolean
}

export function isSupersededSourceSubmission(input: {
  activeSubmissionId: string | null | undefined
  currentRallyId: string | null | undefined
  rallyId: string
  submissionId: string
}) {
  return Boolean(
    input.activeSubmissionId &&
    input.currentRallyId &&
    input.rallyId !== input.currentRallyId &&
    input.submissionId === input.activeSubmissionId,
  )
}

export function adjacentAnnotationKeyPoint(
  points: readonly NavigableAnnotationKeyPoint[],
  input: {
    direction: 'previous' | 'next'
    selectedId: string | null
    referenceCaptureTimeUs: string | null
  },
) {
  const selectedIndex = input.selectedId
    ? points.findIndex(point => point.id === input.selectedId)
    : -1
  if (selectedIndex >= 0) {
    return points[selectedIndex + (input.direction === 'next' ? 1 : -1)] ?? null
  }
  if (input.direction === 'next') {
    return (
      points.find(
        point =>
          !input.referenceCaptureTimeUs ||
          BigInt(point.captureTimeUs) > BigInt(input.referenceCaptureTimeUs),
      ) ?? null
    )
  }
  return (
    points.findLast(
      point =>
        !input.referenceCaptureTimeUs ||
        BigInt(point.captureTimeUs) < BigInt(input.referenceCaptureTimeUs),
    ) ?? null
  )
}
