import { describe, expect, it } from 'vitest'
import { formatManifest } from '../src/routes/media-playback.js'

describe('media playback manifest', () => {
  it('formats deterministic bounded HLS with relative map and segment URLs', () => {
    const manifest = formatManifest('w1', [{ id: 's1', durationUs: 2_000_000n }])
    expect(manifest).toContain('#EXT-X-MAP:URI="init.mp4"')
    expect(manifest).toContain('/api/v1/media/playback-windows/w1/segments/s1')
    expect(manifest).not.toContain('objectKey')
  })
})
