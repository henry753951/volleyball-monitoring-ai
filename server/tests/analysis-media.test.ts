import { describe, expect, it } from 'vitest'
import {
  resolveOverlayAnalysisId,
  resolveOverlaySourceAnalysisRunId,
} from '../src/media/overlay-analysis-id.js'

describe('overlay manifest analysis identity', () => {
  it('reports the analysis id embedded in reused binary chunks', () => {
    expect(
      resolveOverlayAnalysisId('new-analysis', {
        reuse: { source_analysis_id: 'source-analysis' },
      }),
    ).toBe('source-analysis')
  })

  it('reports the current analysis id for newly generated chunks', () => {
    expect(resolveOverlayAnalysisId('new-analysis', {})).toBe('new-analysis')
  })

  it('exposes the source analysis run for legacy reused chunks', () => {
    const payload = {
      reuse: { source_analysis_run_id: 'source-analysis-run' },
    }
    expect(resolveOverlayAnalysisId('new-analysis', payload)).toBe('new-analysis')
    expect(resolveOverlaySourceAnalysisRunId(payload)).toBe('source-analysis-run')
  })
})
