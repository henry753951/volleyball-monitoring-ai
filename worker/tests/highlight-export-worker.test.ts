import { describe, expect, it } from 'vitest'
import { buildHighlightVideoFilter, highlightWindow } from '../src/roles/highlight-export-worker.js'

describe('highlightWindow', () => {
  it('uses three seconds before and two seconds after the event', () => {
    expect(highlightWindow('5000000', '12000000')).toEqual({
      startUs: 2_000_000n,
      durationUs: 5_000_000n,
    })
  })

  it('clamps the replay window to the canonical clip', () => {
    expect(highlightWindow('1000000', '2500000')).toEqual({
      startUs: 0n,
      durationUs: 2_500_000n,
    })
  })
})

describe('buildHighlightVideoFilter', () => {
  it('renders a consistent iPad-friendly frame and escapes Windows drive separators', () => {
    const filter = buildHighlightVideoFilter({
      subjectFile: 'H:\\temp\\subject.txt',
      detailFile: 'H:\\temp\\detail.txt',
      fontFile: 'C:\\Windows\\Fonts\\msjh.ttc',
    })
    expect(filter).toContain('scale=1280:720')
    expect(filter).toContain("fontfile='C\\:/Windows/Fonts/msjh.ttc'")
    expect(filter).toContain("textfile='H\\:/temp/subject.txt'")
    expect(filter).toContain('drawbox=x=0:y=ih-106')
    expect(filter).toContain('fontsize=26')
  })
})
