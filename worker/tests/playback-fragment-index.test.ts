import { describe, expect, it } from 'vitest'
import { scanStoredMediaFragments } from '../src/media/playback-fragment-index'

function box(type: string, payloadBytes: number, extended = false) {
  const header = extended ? 16 : 8
  const bytes = Buffer.alloc(header + payloadBytes)
  if (extended) {
    bytes.writeUInt32BE(1, 0)
    bytes.writeBigUInt64BE(BigInt(bytes.byteLength), 8)
  } else bytes.writeUInt32BE(bytes.byteLength, 0)
  bytes.write(type, 4, 4, 'ascii')
  return bytes
}

describe('stored fMP4 fragment indexing', () => {
  it('returns exact moof plus mdat byte ranges while excluding top-level metadata', () => {
    const bytes = Buffer.concat([
      box('styp', 4),
      box('moof', 8),
      box('mdat', 20),
      box('sidx', 6),
      box('moof', 10, true),
      box('mdat', 30),
      box('mfra', 4),
    ])

    expect(scanStoredMediaFragments(bytes)).toEqual([
      { byteOffset: 12n, byteLength: 44n },
      { byteOffset: 70n, byteLength: 64n },
    ])
  })

  it('rejects truncated and unpaired media boxes', () => {
    expect(() => scanStoredMediaFragments(Buffer.concat([box('moof', 8), box('free', 4)]))).toThrow(
      'followed immediately',
    )
    const truncated = box('mdat', 4)
    truncated.writeUInt32BE(100, 0)
    expect(() => scanStoredMediaFragments(Buffer.concat([box('moof', 8), truncated]))).toThrow(
      'exceeds the object',
    )
  })
})
