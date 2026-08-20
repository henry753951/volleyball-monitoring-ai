export type StoredMediaFragmentRange = {
  byteOffset: bigint
  byteLength: bigint
}

export class PlaybackFragmentIndexError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlaybackFragmentIndexError'
  }
}

type Mp4Box = {
  type: string
  offset: number
  contentOffset: number
  end: number
}

type TrackDefaults = {
  trackId: number
  defaultSampleFlags: number | null
}

const MAX_SAFE_BYTES = BigInt(Number.MAX_SAFE_INTEGER)
const MEDIA_BOX_TYPES = new Set([
  'styp',
  'sidx',
  'ssix',
  'prft',
  'emsg',
  'free',
  'skip',
  'uuid',
  'mfra',
])

function fail(message: string): never {
  throw new PlaybackFragmentIndexError(message)
}

function requireBytes(bytes: Uint8Array, offset: number, length: number, label: string): void {
  if (offset < 0 || length < 0 || offset + length > bytes.byteLength) {
    fail(`${label} is truncated`)
  }
}

function uint32(bytes: Uint8Array, offset: number, label: string): number {
  requireBytes(bytes, offset, 4, label)
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0)
}

function uint64(bytes: Uint8Array, offset: number, label: string): bigint {
  requireBytes(bytes, offset, 8, label)
  let value = 0n
  for (let index = 0; index < 8; index += 1) value = (value << 8n) | BigInt(bytes[offset + index]!)
  return value
}

function boxType(bytes: Uint8Array, offset: number): string {
  requireBytes(bytes, offset + 4, 4, 'media box type')
  return String.fromCharCode(
    bytes[offset + 4]!,
    bytes[offset + 5]!,
    bytes[offset + 6]!,
    bytes[offset + 7]!,
  )
}

function parseBoxes(bytes: Uint8Array, start = 0, end = bytes.byteLength): readonly Mp4Box[] {
  if (start < 0 || end < start || end > bytes.byteLength) fail('media box bounds are invalid')
  const boxes: Mp4Box[] = []
  let position = start
  while (position < end) {
    if (end - position < 8) fail('media box header is truncated')
    const size32 = uint32(bytes, position, 'media box header')
    const type = boxType(bytes, position)
    const headerBytes = size32 === 1 ? 16 : 8
    if (end - position < headerBytes) fail('extended media box header is truncated')
    const size =
      size32 === 0
        ? BigInt(end - position)
        : size32 === 1
          ? uint64(bytes, position + 8, 'extended media box size')
          : BigInt(size32)
    if (size < BigInt(headerBytes) || size > MAX_SAFE_BYTES) {
      fail(`media box ${type} has an invalid size`)
    }
    const boxEnd = position + Number(size)
    if (boxEnd > end) fail(`media box ${type} exceeds its parent`)
    boxes.push({ type, offset: position, contentOffset: position + headerBytes, end: boxEnd })
    position = boxEnd
  }
  return boxes
}

function childBoxes(bytes: Uint8Array, parent: Mp4Box): readonly Mp4Box[] {
  return parseBoxes(bytes, parent.contentOffset, parent.end)
}

function onlyBox(boxes: readonly Mp4Box[], type: string, context: string): Mp4Box {
  const matches = boxes.filter(box => box.type === type)
  if (matches.length !== 1) fail(`${context} must contain exactly one ${type} box`)
  return matches[0]!
}

function fullBoxFlags(bytes: Uint8Array, box: Mp4Box): number {
  requireBytes(bytes, box.contentOffset, 4, `${box.type} full-box header`)
  return (
    (bytes[box.contentOffset + 1]! << 16) |
    (bytes[box.contentOffset + 2]! << 8) |
    bytes[box.contentOffset + 3]!
  )
}

function trackIdFromTkhd(bytes: Uint8Array, box: Mp4Box): number {
  requireBytes(bytes, box.contentOffset, 4, 'tkhd full-box header')
  const version = bytes[box.contentOffset]!
  const offset =
    box.contentOffset +
    (version === 1 ? 20 : version === 0 ? 12 : fail('tkhd version is unsupported'))
  const trackId = uint32(bytes, offset, 'tkhd track id')
  if (trackId === 0) fail('video track id is invalid')
  return trackId
}

function handlerType(bytes: Uint8Array, box: Mp4Box): string {
  requireBytes(bytes, box.contentOffset + 8, 4, 'hdlr handler type')
  return String.fromCharCode(
    bytes[box.contentOffset + 8]!,
    bytes[box.contentOffset + 9]!,
    bytes[box.contentOffset + 10]!,
    bytes[box.contentOffset + 11]!,
  )
}

function videoTrackDefaults(initBytes: Uint8Array): TrackDefaults {
  const moov = onlyBox(parseBoxes(initBytes), 'moov', 'initialization segment')
  const moovChildren = childBoxes(initBytes, moov)
  const videoTracks = moovChildren
    .filter(box => box.type === 'trak')
    .flatMap(trak => {
      const children = childBoxes(initBytes, trak)
      const tkhd = onlyBox(children, 'tkhd', 'trak')
      const mdia = onlyBox(children, 'mdia', 'trak')
      const hdlr = onlyBox(childBoxes(initBytes, mdia), 'hdlr', 'mdia')
      return handlerType(initBytes, hdlr) === 'vide' ? [trackIdFromTkhd(initBytes, tkhd)] : []
    })
  if (videoTracks.length !== 1) fail('initialization segment must contain exactly one video track')
  const trackId = videoTracks[0]!
  const mvex = moovChildren.find(box => box.type === 'mvex')
  const trex = mvex
    ? childBoxes(initBytes, mvex).find(
        box =>
          box.type === 'trex' &&
          uint32(initBytes, box.contentOffset + 4, 'trex track id') === trackId,
      )
    : undefined
  return {
    trackId,
    defaultSampleFlags: trex
      ? uint32(initBytes, trex.contentOffset + 20, 'trex sample flags')
      : null,
  }
}

function tfhdDefaults(bytes: Uint8Array, box: Mp4Box): TrackDefaults {
  const flags = fullBoxFlags(bytes, box)
  const trackId = uint32(bytes, box.contentOffset + 4, 'tfhd track id')
  let position = box.contentOffset + 8
  if (flags & 0x000001) position += 8
  if (flags & 0x000002) position += 4
  if (flags & 0x000008) position += 4
  if (flags & 0x000010) position += 4
  const defaultSampleFlags = flags & 0x000020 ? uint32(bytes, position, 'tfhd sample flags') : null
  return { trackId, defaultSampleFlags }
}

function firstTrunSampleFlags(
  bytes: Uint8Array,
  box: Mp4Box,
  defaultSampleFlags: number | null,
): { sampleCount: number; flags: number | null } {
  const flags = fullBoxFlags(bytes, box)
  const sampleCount = uint32(bytes, box.contentOffset + 4, 'trun sample count')
  if (sampleCount === 0) return { sampleCount, flags: null }
  let position = box.contentOffset + 8
  if (flags & 0x000001) position += 4
  if (flags & 0x000004) {
    return { sampleCount, flags: uint32(bytes, position, 'trun first sample flags') }
  }
  if (flags & 0x000100) position += 4
  if (flags & 0x000200) position += 4
  return {
    sampleCount,
    flags: flags & 0x000400 ? uint32(bytes, position, 'trun sample flags') : defaultSampleFlags,
  }
}

function moofContainsIndependentVideo(
  bytes: Uint8Array,
  moof: Mp4Box,
  video: TrackDefaults,
): boolean {
  const videoTrafs = childBoxes(bytes, moof)
    .filter(box => box.type === 'traf')
    .flatMap(traf => {
      const children = childBoxes(bytes, traf)
      const defaults = tfhdDefaults(bytes, onlyBox(children, 'tfhd', 'traf'))
      return defaults.trackId === video.trackId ? [{ children, defaults }] : []
    })
  if (videoTrafs.length === 0) return false
  if (videoTrafs.length !== 1) fail('media fragment contains multiple video traf boxes')
  const { children, defaults } = videoTrafs[0]!
  const runs = children.filter(box => box.type === 'trun')
  if (runs.length === 0) fail('video traf has no trun box')
  for (const run of runs) {
    const first = firstTrunSampleFlags(
      bytes,
      run,
      defaults.defaultSampleFlags ?? video.defaultSampleFlags,
    )
    if (first.sampleCount === 0) continue
    if (first.flags === null) fail('video fragment does not declare first-sample sync flags')
    if ((first.flags & 0x00010000) !== 0) fail('video fragment does not begin with a sync sample')
    return true
  }
  fail('video traf contains no samples')
}

/**
 * Build independently decodable video fragment ranges from a fragmented MP4.
 * Every published range is proven to start with a sync video sample. Any
 * following audio-only moof/mdat pairs are folded into that video range.
 */
export function scanStoredMediaFragments(
  mediaBytes: Uint8Array,
  initBytes: Uint8Array,
): readonly StoredMediaFragmentRange[] {
  if (
    mediaBytes.byteLength < 16 ||
    initBytes.byteLength < 16 ||
    BigInt(mediaBytes.byteLength) > MAX_SAFE_BYTES ||
    BigInt(initBytes.byteLength) > MAX_SAFE_BYTES
  ) {
    fail('fragmented MP4 object size is invalid')
  }

  const video = videoTrackDefaults(initBytes)
  const fragments: StoredMediaFragmentRange[] = []
  const boxes = parseBoxes(mediaBytes)
  for (let index = 0; index < boxes.length; index += 1) {
    const box = boxes[index]!
    if (box.type !== 'moof') {
      if (box.type === 'mdat') fail('mdat must follow a moof box')
      if (!MEDIA_BOX_TYPES.has(box.type)) fail(`unsupported media box ${box.type}`)
      continue
    }
    const mdat = boxes[index + 1]
    if (!mdat || mdat.type !== 'mdat') fail('each moof must be followed immediately by mdat')
    const independentVideo = moofContainsIndependentVideo(mediaBytes, box, video)
    if (independentVideo) {
      fragments.push({
        byteOffset: BigInt(box.offset),
        byteLength: BigInt(mdat.end - box.offset),
      })
    } else {
      const previous = fragments.at(-1)
      if (!previous) fail('audio-only media fragment appears before the first video fragment')
      previous.byteLength = BigInt(mdat.end) - previous.byteOffset
    }
    index += 1
  }

  if (fragments.length === 0) fail('media object has no independent video fragments')
  return fragments
}
