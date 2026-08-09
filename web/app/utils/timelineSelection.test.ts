import { describe, expect, it } from 'vitest'
import { toggleAnalysisResultSelection } from './timelineSelection'

describe('toggleAnalysisResultSelection', () => {
  it('pins the analysis parent when neither cursor nor segment is selected', () => {
    expect(toggleAnalysisResultSelection({
      currentAnalysisSegmentId: null,
      targetSegmentId: 'rally-a',
      cursorRallyId: null,
    })).toEqual({
      pinnedRallyId: 'rally-a',
      selectedAnalysisSegmentId: 'rally-a',
      selectedTimelineItem: 'analysis',
    })
  })

  it('replaces an existing segment context with the selected analysis parent', () => {
    expect(toggleAnalysisResultSelection({
      currentAnalysisSegmentId: null,
      targetSegmentId: 'rally-a',
      cursorRallyId: 'rally-b',
    })).toEqual({
      pinnedRallyId: 'rally-a',
      selectedAnalysisSegmentId: 'rally-a',
      selectedTimelineItem: 'analysis',
    })
  })

  it('pins the result even when its parent is only selected by the cursor', () => {
    expect(toggleAnalysisResultSelection({
      currentAnalysisSegmentId: null,
      targetSegmentId: 'rally-a',
      cursorRallyId: 'rally-a',
    })).toEqual({
      pinnedRallyId: 'rally-a',
      selectedAnalysisSegmentId: 'rally-a',
      selectedTimelineItem: 'analysis',
    })
  })

  it('toggles the result off and restores cursor-driven segment context', () => {
    expect(toggleAnalysisResultSelection({
      currentAnalysisSegmentId: 'rally-a',
      targetSegmentId: 'rally-a',
      cursorRallyId: 'rally-b',
    })).toEqual({
      pinnedRallyId: null,
      selectedAnalysisSegmentId: null,
      selectedTimelineItem: 'segment',
    })
  })
})
