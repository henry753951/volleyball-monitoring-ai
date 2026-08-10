import { describe, expect, it } from 'vitest'
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
