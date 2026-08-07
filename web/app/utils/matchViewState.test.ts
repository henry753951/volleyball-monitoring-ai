import { describe, expect, it } from 'vitest'
import { classifyMatchViewState } from './matchViewState'

describe('match view states', () => {
  it('keeps loading, API error and inaccessible/not-found states distinct', () => {
    expect(classifyMatchViewState(true, null, null)).toBe('loading')
    expect(classifyMatchViewState(false, new Error('failed'), null)).toBe('error')
    expect(classifyMatchViewState(false, null, null)).toBe('not_found')
    expect(classifyMatchViewState(false, null, { id: 'real' })).toBe('ready')
  })
})
