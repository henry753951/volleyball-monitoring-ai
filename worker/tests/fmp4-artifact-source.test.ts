import { describe, expect, it } from 'vitest'
import {
  FinalizedFileArtifactSource,
  Fmp4ArtifactSourceError,
  type ArtifactFileHandle,
  type ArtifactFileStat,
  type ArtifactFileSystem,
  type Fmp4ArtifactSourceConfig,
} from '../src/media/fmp4-artifact-source'
import type { FinalizedRecording } from '../src/media/finalized-recording'

function box(type: string, payload: Uint8Array = Uint8Array.of(1), extended = false): Buffer {
  const headerLength = extended ? 16 : 8
  const result = Buffer.alloc(headerLength + payload.byteLength)
  if (extended) {
    result.writeUInt32BE(1, 0)
    result.writeBigUInt64BE(BigInt(result.byteLength), 8)
  } else {
    result.writeUInt32BE(result.byteLength, 0)
  }
  result.write(type, 4, 4, 'ascii')
  Buffer.from(payload).copy(result, headerLength)
  return result
}

const ftyp = box('ftyp', Buffer.from('isom\x00\x00\x00\x01', 'binary'))
const moov = box('moov', Uint8Array.of(2, 3, 4))
const moof = box('moof', Uint8Array.of(5, 6))
const mdat = box('mdat', Uint8Array.of(7, 8, 9, 10))

const defaultConfig: Fmp4ArtifactSourceConfig = {
  maxInputBytes: 1_000_000n,
  maxInitBytes: 100_000n,
  maxMediaBytes: 900_000n,
  readTimeoutMs: 1_000,
  readChunkBytes: 3,
}

const baseStat: ArtifactFileStat = {
  size: 0n,
  mtimeNs: 100n,
  device: 1n,
  inode: 2n,
  isFile: true,
}

class MemoryFileHandle implements ArtifactFileHandle {
  closed = false
  readCalls = 0

  constructor(
    private readonly bytes: Buffer,
    private readonly beforeRead?: () => Promise<void>,
  ) {}

  async read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }> {
    this.readCalls += 1
    await this.beforeRead?.()
    const available = Math.max(0, this.bytes.byteLength - position)
    const bytesRead = Math.min(length, available)
    if (bytesRead > 0) {
      buffer.set(this.bytes.subarray(position, position + bytesRead), offset)
    }
    return { bytesRead }
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

class MemoryFileSystem implements ArtifactFileSystem {
  statCalls = 0
  readonly handle: MemoryFileHandle

  constructor(
    bytes: Buffer,
    private readonly stats: readonly ArtifactFileStat[] = [
      { ...baseStat, size: BigInt(bytes.byteLength) },
    ],
    beforeRead?: () => Promise<void>,
  ) {
    this.handle = new MemoryFileHandle(bytes, beforeRead)
  }

  async stat(): Promise<ArtifactFileStat> {
    const result = this.stats[Math.min(this.statCalls, this.stats.length - 1)]!
    this.statCalls += 1
    return result
  }

  async open(): Promise<ArtifactFileHandle> {
    return this.handle
  }
}

function recording(bytes: Uint8Array): FinalizedRecording {
  return {
    captureSessionId: 'capture-01',
    trustedPath: 'H:\\trusted-spool\\segment.mp4',
    sourceIdentity: 'segment.mp4',
    byteLength: BigInt(bytes.byteLength),
    mtimeNs: 100n,
    finalized: true,
  }
}

async function split(
  bytes: Buffer,
  config: Fmp4ArtifactSourceConfig = defaultConfig,
  fileSystem = new MemoryFileSystem(bytes),
) {
  const source = new FinalizedFileArtifactSource(config, fileSystem)
  return source.read(recording(bytes))
}

describe('FinalizedFileArtifactSource', () => {
  it('splits initialization and one finalized fragment in original order', async () => {
    const free = box('free', Uint8Array.of(11, 12))
    const bytes = Buffer.concat([ftyp, free, moov, moof, mdat])

    await expect(split(bytes)).resolves.toEqual({
      initBytes: Buffer.concat([ftyp, free, moov]),
      mediaBytes: Buffer.concat([moof, mdat]),
    })
  })

  it('preserves timing boxes and multiple moof/mdat fragments', async () => {
    const styp = box('styp', Uint8Array.of(1, 2))
    const sidx = box('sidx', Uint8Array.of(3, 4))
    const emsg = box('emsg', Uint8Array.of(5))
    const secondMoof = box('moof', Uint8Array.of(13))
    const secondMdat = box('mdat', Uint8Array.of(14, 15))
    const bytes = Buffer.concat([ftyp, moov, styp, sidx, moof, mdat, emsg, secondMoof, secondMdat])

    const result = await split(bytes)

    expect(result.initBytes).toEqual(Buffer.concat([ftyp, moov]))
    expect(result.mediaBytes).toEqual(
      Buffer.concat([styp, sidx, moof, mdat, emsg, secondMoof, secondMdat]),
    )
    expect(result.mediaFragments).toBeUndefined()
  })

  it('remuxes an OME-style progressive MP4 before splitting artifacts', async () => {
    const free = box('free', Uint8Array.of(11, 12))
    const progressive = Buffer.concat([ftyp, free, mdat, moov])
    const fragmented = {
      initBytes: Buffer.concat([ftyp, moov]),
      mediaBytes: Buffer.concat([moof, mdat]),
    }
    const fileSystem = new MemoryFileSystem(progressive)
    const calls: string[] = []
    const source = new FinalizedFileArtifactSource(defaultConfig, fileSystem, async path => {
      calls.push(path)
      return fragmented
    })

    await expect(source.read(recording(progressive))).resolves.toEqual(fragmented)
    expect(calls).toEqual(['H:\\trusted-spool\\segment.mp4'])
    expect(fileSystem.handle.closed).toBe(true)
  })

  it('validates and preserves a 64-bit extended-size box', async () => {
    const extendedFtyp = box('ftyp', Buffer.from('iso6\x00\x00\x00\x01', 'binary'), true)
    const bytes = Buffer.concat([extendedFtyp, moov, moof, mdat])

    const result = await split(bytes)

    expect(result.initBytes).toEqual(Buffer.concat([extendedFtyp, moov]))
  })

  it('preserves an explicitly allowed unknown media box', async () => {
    const unknown = box('zzzz', Uint8Array.of(42))
    const bytes = Buffer.concat([ftyp, moov, unknown, moof, mdat])

    const result = await split(bytes, {
      ...defaultConfig,
      additionalMediaBoxTypes: ['zzzz'],
    })

    expect(result.mediaBytes).toEqual(Buffer.concat([unknown, moof, mdat]))
  })

  it.each([
    ['truncated header', Buffer.from([0, 0, 0, 8])],
    ['declared truncation', Buffer.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70])],
    ['size zero', Buffer.from([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70])],
    ['size smaller than header', Buffer.from([0, 0, 0, 4, 0x66, 0x74, 0x79, 0x70])],
    [
      '64-bit overflow',
      (() => {
        const value = Buffer.alloc(16)
        value.writeUInt32BE(1, 0)
        value.write('ftyp', 4, 4, 'ascii')
        value.writeBigUInt64BE(0xffff_ffff_ffff_ffffn, 8)
        return value
      })(),
    ],
  ])('rejects malformed %s input', async (_label, bytes) => {
    await expect(split(bytes)).rejects.toMatchObject({ code: 'INVALID_BOX' })
  })

  it.each([
    ['moov before ftyp', Buffer.concat([moov, ftyp, moof, mdat])],
    ['missing moov', Buffer.concat([ftyp, moof, mdat])],
    ['mdat before moof', Buffer.concat([ftyp, moov, mdat])],
    ['missing mdat', Buffer.concat([ftyp, moov, moof])],
    ['no fragments', Buffer.concat([ftyp, moov])],
    ['init after media', Buffer.concat([ftyp, moov, moof, mdat, moov])],
  ])('rejects invalid box order: %s', async (_label, bytes) => {
    await expect(split(bytes)).rejects.toMatchObject({ code: 'INVALID_LAYOUT' })
  })

  it('enforces input, init-output, and media-output bounds', async () => {
    const bytes = Buffer.concat([ftyp, moov, moof, mdat])

    await expect(
      split(bytes, { ...defaultConfig, maxInputBytes: BigInt(bytes.length - 1) }),
    ).rejects.toMatchObject({ code: 'INPUT_TOO_LARGE' })
    await expect(
      split(bytes, {
        ...defaultConfig,
        maxInitBytes: BigInt(ftyp.length + moov.length - 1),
      }),
    ).rejects.toMatchObject({ code: 'OUTPUT_TOO_LARGE' })
    await expect(
      split(bytes, {
        ...defaultConfig,
        maxMediaBytes: BigInt(moof.length + mdat.length - 1),
      }),
    ).rejects.toMatchObject({ code: 'OUTPUT_TOO_LARGE' })
  })

  it('fails when the finalized file mutates during streaming read', async () => {
    const bytes = Buffer.concat([ftyp, moov, moof, mdat])
    const fileSystem = new MemoryFileSystem(bytes, [
      { ...baseStat, size: BigInt(bytes.length) },
      { ...baseStat, size: BigInt(bytes.length), mtimeNs: 101n },
    ])

    await expect(split(bytes, defaultConfig, fileSystem)).rejects.toMatchObject({
      code: 'SOURCE_CHANGED',
    })
    expect(fileSystem.handle.closed).toBe(true)
  })

  it('aborts an in-progress streaming read and closes the handle', async () => {
    const bytes = Buffer.concat([ftyp, moov, moof, mdat])
    const controller = new AbortController()
    let firstRead = true
    const fileSystem = new MemoryFileSystem(bytes, undefined, async () => {
      if (firstRead) {
        firstRead = false
        controller.abort()
        await Promise.resolve()
      }
    })
    const source = new FinalizedFileArtifactSource(defaultConfig, fileSystem)

    await expect(
      source.read(recording(bytes), { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'ABORTED' })
    expect(fileSystem.handle.closed).toBe(true)
  })

  it('rejects a pre-read size or mtime identity mismatch', async () => {
    const bytes = Buffer.concat([ftyp, moov, moof, mdat])
    const fileSystem = new MemoryFileSystem(bytes, [
      { ...baseStat, size: BigInt(bytes.length), mtimeNs: 99n },
    ])

    await expect(split(bytes, defaultConfig, fileSystem)).rejects.toMatchObject({
      code: 'SOURCE_CHANGED',
    })
  })

  it('does not trust extension or caller-provided content type', async () => {
    const bytes = Buffer.concat([ftyp, moov, moof, mdat])
    const source = new FinalizedFileArtifactSource(defaultConfig, new MemoryFileSystem(bytes))
    const value = { ...recording(bytes), trustedPath: 'H:\\trusted\\opaque.bin' }

    const result = await source.read(value)

    expect(result.initBytes).toBeInstanceOf(Uint8Array)
    expect(result.mediaBytes).toBeInstanceOf(Uint8Array)
    expect(value).not.toHaveProperty('contentType')
  })

  it('returns stable typed errors without exposing the trusted path', async () => {
    const bytes = Buffer.concat([ftyp, moov, moof])
    const trustedPath = 'H:\\private-secret-path\\capture.mp4'
    const source = new FinalizedFileArtifactSource(defaultConfig, new MemoryFileSystem(bytes))

    try {
      await source.read({ ...recording(bytes), trustedPath })
      throw new Error('expected read failure')
    } catch (error) {
      expect(error).toBeInstanceOf(Fmp4ArtifactSourceError)
      expect(String(error)).not.toContain(trustedPath)
    }
  })
})
