import { describe, expect, it } from 'vitest'
import { selectIdentityPreviewFrames } from '../src/roles/identity-preview-worker.js'

describe('identity preview frame planning', () => {
  it('uses chronological feature frames within the immutable tracklet', () => {
    expect(
      selectIdentityPreviewFrames({
        firstFrameIndex: 100n,
        lastFrameIndex: 160n,
        vectorFrameIndices: [
          [144n, 108n, 132n],
          [108n, 156n, 999n],
        ],
      }),
    ).toEqual([108n, 132n, 144n, 156n])
  })

  it('falls back to a bounded chronological sample instead of rerunning pose selection', () => {
    const frames = selectIdentityPreviewFrames({
      firstFrameIndex: 10n,
      lastFrameIndex: 109n,
      vectorFrameIndices: [],
    })

    expect(frames).toHaveLength(12)
    expect(frames[0]).toBe(10n)
    expect(frames.at(-1)).toBe(109n)
    expect(frames.every((value, index) => index === 0 || value > frames[index - 1]!)).toBe(true)
  })
})
