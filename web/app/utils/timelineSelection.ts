export type TimelineSelectionItem = 'mask' | 'point' | 'segment' | 'analysis' | null

export interface AnalysisSelectionResolution {
  pinnedRallyId: string | null
  selectedAnalysisSegmentId: string | null
  selectedTimelineItem: Extract<TimelineSelectionItem, 'analysis' | 'segment'> | null
}

export function toggleAnalysisResultSelection(input: {
  currentAnalysisSegmentId: string | null
  targetSegmentId: string
  cursorRallyId: string | null
}): AnalysisSelectionResolution {
  if (input.currentAnalysisSegmentId === input.targetSegmentId) {
    return {
      pinnedRallyId: null,
      selectedAnalysisSegmentId: null,
      selectedTimelineItem: input.cursorRallyId ? 'segment' : null,
    }
  }

  return {
    pinnedRallyId: input.targetSegmentId,
    selectedAnalysisSegmentId: input.targetSegmentId,
    selectedTimelineItem: 'analysis',
  }
}
