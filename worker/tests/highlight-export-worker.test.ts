import { describe, expect, it } from 'vitest'
import {
  buildHighlightVideoFilter,
  highlightFailure,
  highlightWindow,
} from '../src/roles/highlight-export-worker.js'

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

describe('highlightFailure', () => {
  it('classifies a missing MinIO source separately from FFmpeg failures', () => {
    expect(highlightFailure({ code: 'NoSuchKey' })).toEqual({
      sourceMissing: true,
      code: 'HIGHLIGHT_SOURCE_MISSING',
      message: '回放來源影片已不存在，請先重新產生片段後再輸出。',
    })
  })

  it('keeps the bounded process error for a real encoder failure', () => {
    expect(highlightFailure(new Error('ffmpeg failed (1): invalid input'))).toEqual({
      sourceMissing: false,
      code: 'HIGHLIGHT_EXPORT_FAILED',
      message: 'ffmpeg failed (1): invalid input',
    })
  })
})
