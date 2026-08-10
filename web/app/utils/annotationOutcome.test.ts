import { describe, expect, it } from 'vitest'
import { annotationOutcomeLabel } from './annotationOutcome'

describe('annotation outcome label', () => {
  const teams = [
    { id: 'tpe', name: 'Chinese Taipei', shortName: 'TPE' },
    { id: 'pur', name: 'Puerto Rico', shortName: 'PUR' },
  ]

  it('hides a pending result', () => {
    expect(annotationOutcomeLabel({ scoreResolution: 'pending' })).toBeNull()
  })

  it('shows an explicit unknown result', () => {
    expect(annotationOutcomeLabel({ scoreResolution: 'unknown' })).toBe('得分未知')
  })

  it('prefers the scoring team identity over its temporary court side', () => {
    expect(annotationOutcomeLabel({
      scoreResolution: 'resolved',
      scoringCourtSide: 'right',
      scoringTeamId: 'tpe',
      teams,
    })).toBe('TPE 得分')
  })

  it('falls back to the visible side label for a live draft', () => {
    expect(annotationOutcomeLabel({
      leftLabel: 'TPE',
      scoreResolution: 'resolved',
      scoringCourtSide: 'left',
    })).toBe('TPE 得分')
  })
})
