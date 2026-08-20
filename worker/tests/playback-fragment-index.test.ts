import { describe, expect, it } from 'vitest'
import { scanStoredMediaFragments } from '../src/media/playback-fragment-index'

function box(type: string, payload: Buffer, extended = false) {
  const header = extended ? 16 : 8
  const bytes = Buffer.alloc(header + payload.byteLength)
  if (extended) {
    bytes.writeUInt32BE(1, 0)
    bytes.writeBigUInt64BE(BigInt(bytes.byteLength), 8)
  } else bytes.writeUInt32BE(bytes.byteLength, 0)
  bytes.write(type, 4, 4, 'ascii')
  payload.copy(bytes, header)
  return bytes
}

function container(type: string, ...children: Buffer[]) {
  return box(type, Buffer.concat(children))
}

function fullBox(type: string, body: Buffer, flags = 0) {
  const payload = Buffer.alloc(4 + body.byteLength)
  payload.writeUIntBE(flags, 1, 3)
  body.copy(payload, 4)
  return box(type, payload)
}

function initialization() {
  const tkhdBody = Buffer.alloc(16)
  tkhdBody.writeUInt32BE(1, 8)
  const hdlrBody = Buffer.alloc(8)
  hdlrBody.write('vide', 4, 4, 'ascii')
  const trak = container(
    'trak',
    fullBox('tkhd', tkhdBody),
    container('mdia', fullBox('hdlr', hdlrBody)),
  )
  const trexBody = Buffer.alloc(20)
  trexBody.writeUInt32BE(1, 0)
  trexBody.writeUInt32BE(0, 16)
  return Buffer.concat([
    box('ftyp', Buffer.from('isom')),
    container('moov', trak, container('mvex', fullBox('trex', trexBody))),
  ])
}

function fragment(trackId: number, sampleFlags = 0, extendedMdat = false) {
  const tfhdBody = Buffer.alloc(8)
  tfhdBody.writeUInt32BE(trackId, 0)
  tfhdBody.writeUInt32BE(sampleFlags, 4)
  const trunBody = Buffer.alloc(8)
  trunBody.writeUInt32BE(1, 0)
  trunBody.writeUInt32BE(sampleFlags, 4)
  return [
    container(
      'moof',
      fullBox('mfhd', Buffer.alloc(4)),
      container('traf', fullBox('tfhd', tfhdBody, 0x000020), fullBox('trun', trunBody, 0x000004)),
    ),
    box('mdat', Buffer.alloc(20), extendedMdat),
  ] as const
}

describe('stored fMP4 fragment indexing', () => {
  it('groups audio-only tails behind independently decodable video fragments', () => {
    const init = initialization()
    const styp = box('styp', Buffer.alloc(4))
    const firstVideo = fragment(1)
    const sidx = box('sidx', Buffer.alloc(6))
    const audioTail = fragment(2)
    const secondVideo = fragment(1, 0, true)
    const mfra = box('mfra', Buffer.alloc(4))
    const bytes = Buffer.concat([styp, ...firstVideo, sidx, ...audioTail, ...secondVideo, mfra])
    const firstStart = BigInt(styp.byteLength)
    const firstEnd = BigInt(
      styp.byteLength +
        firstVideo[0].byteLength +
        firstVideo[1].byteLength +
        sidx.byteLength +
        audioTail[0].byteLength +
        audioTail[1].byteLength,
    )
    const secondStart = firstEnd
    const secondLength = BigInt(secondVideo[0].byteLength + secondVideo[1].byteLength)

    expect(scanStoredMediaFragments(bytes, init)).toEqual([
      { byteOffset: firstStart, byteLength: firstEnd - firstStart },
      { byteOffset: secondStart, byteLength: secondLength },
    ])
  })

  it('rejects a video range that does not start with a sync sample', () => {
    expect(() =>
      scanStoredMediaFragments(Buffer.concat(fragment(1, 0x00010000)), initialization()),
    ).toThrow('sync sample')
  })

  it('rejects audio before video and truncated media boxes', () => {
    expect(() => scanStoredMediaFragments(Buffer.concat(fragment(2)), initialization())).toThrow(
      'before the first video',
    )
    const truncated = box('mdat', Buffer.alloc(4))
    truncated.writeUInt32BE(100, 0)
    expect(() =>
      scanStoredMediaFragments(Buffer.concat([fragment(1)[0], truncated]), initialization()),
    ).toThrow('exceeds its parent')
  })
})
