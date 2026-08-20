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

function boxType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset + 4]!,
    bytes[offset + 5]!,
    bytes[offset + 6]!,
    bytes[offset + 7]!,
  )
}

function uint64(bytes: Uint8Array, offset: number): bigint {
  let value = 0n
  for (let index = 0; index < 8; index += 1) value = (value << 8n) | BigInt(bytes[offset + index]!)
  return value
}

/**
 * Scan an already separated fMP4 media object without decoding or copying it.
 * The returned ranges contain complete moof+mdat pairs suitable for HLS
 * EXT-X-BYTERANGE. Initialization bytes belong to the separate init asset.
 */
export function scanStoredMediaFragments(bytes: Uint8Array): readonly StoredMediaFragmentRange[] {
  if (bytes.byteLength < 16 || BigInt(bytes.byteLength) > MAX_SAFE_BYTES)
    throw new PlaybackFragmentIndexError('media object size is invalid')

  const fragments: StoredMediaFragmentRange[] = []
  let position = 0
  let fragmentStart: number | null = null
  let awaitingMdat = false

  while (position < bytes.byteLength) {
    if (bytes.byteLength - position < 8)
      throw new PlaybackFragmentIndexError('media box header is truncated')
    const view = new DataView(
      bytes.buffer,
      bytes.byteOffset + position,
      bytes.byteLength - position,
    )
    const size32 = view.getUint32(0)
    const type = boxType(bytes, position)
    const headerBytes = size32 === 1 ? 16 : 8
    if (bytes.byteLength - position < headerBytes)
      throw new PlaybackFragmentIndexError('extended media box header is truncated')
    const size =
      size32 === 0
        ? BigInt(bytes.byteLength - position)
        : size32 === 1
          ? uint64(bytes, position + 8)
          : BigInt(size32)
    if (size < BigInt(headerBytes) || size > MAX_SAFE_BYTES)
      throw new PlaybackFragmentIndexError(`media box ${type} has an invalid size`)
    const boxBytes = Number(size)
    if (position + boxBytes > bytes.byteLength)
      throw new PlaybackFragmentIndexError(`media box ${type} exceeds the object`)

    if (awaitingMdat) {
      if (type !== 'mdat')
        throw new PlaybackFragmentIndexError('each moof must be followed immediately by mdat')
      if (fragmentStart === null)
        throw new PlaybackFragmentIndexError('media fragment start is missing')
      fragments.push({
        byteOffset: BigInt(fragmentStart),
        byteLength: BigInt(position + boxBytes - fragmentStart),
      })
      fragmentStart = null
      awaitingMdat = false
    } else if (type === 'moof') {
      fragmentStart = position
      awaitingMdat = true
    } else if (type === 'mdat') {
      throw new PlaybackFragmentIndexError('mdat must follow a moof box')
    } else if (!MEDIA_BOX_TYPES.has(type)) {
      throw new PlaybackFragmentIndexError(`unsupported media box ${type}`)
    }
    position += boxBytes
  }

  if (awaitingMdat || fragments.length === 0)
    throw new PlaybackFragmentIndexError('media object has no complete fragments')
  return fragments
}
