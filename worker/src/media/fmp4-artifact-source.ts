import { open as openFile, stat as statFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { assertFinalizedRecording, type FinalizedRecording } from './finalized-recording'
import type { ArtifactSource, ArtifactSourceBytes } from './ingest'

export type Fmp4ArtifactSourceErrorCode =
  | 'INVALID_CONFIG'
  | 'ABORTED'
  | 'TIMEOUT'
  | 'SOURCE_CHANGED'
  | 'INPUT_TOO_LARGE'
  | 'OUTPUT_TOO_LARGE'
  | 'INVALID_BOX'
  | 'INVALID_LAYOUT'

export class Fmp4ArtifactSourceError extends Error {
  constructor(
    public readonly code: Fmp4ArtifactSourceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'Fmp4ArtifactSourceError'
  }
}

export type Fmp4ArtifactSourceConfig = {
  maxInputBytes: bigint
  maxInitBytes: bigint
  maxMediaBytes: bigint
  readTimeoutMs: number
  readChunkBytes?: number
  additionalInitBoxTypes?: readonly string[]
  additionalMediaBoxTypes?: readonly string[]
}

export type ArtifactSourceReadOptions = {
  signal?: AbortSignal
}

export type ArtifactFileStat = {
  size: bigint
  mtimeNs: bigint
  device: bigint
  inode: bigint
  isFile: boolean
}

export interface ArtifactFileHandle {
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>
  close(): Promise<void>
}

export interface ArtifactFileSystem {
  stat(path: string): Promise<ArtifactFileStat>
  open(path: string): Promise<ArtifactFileHandle>
}

const DEFAULT_INIT_BOX_TYPES = ['free', 'skip', 'wide', 'uuid', 'pdin'] as const
const DEFAULT_MEDIA_BOX_TYPES = [
  'styp',
  'sidx',
  'ssix',
  'prft',
  'emsg',
  'free',
  'skip',
  'uuid',
  'mfra',
] as const
const RESERVED_BOX_TYPES = new Set(['ftyp', 'moov', 'moof', 'mdat'])
const MAX_SAFE_BYTES = BigInt(Number.MAX_SAFE_INTEGER)

const nodeFileSystem: ArtifactFileSystem = {
  async stat(path) {
    const value = await statFile(path, { bigint: true })
    return {
      size: value.size,
      mtimeNs: value.mtimeNs,
      device: value.dev,
      inode: value.ino,
      isFile: value.isFile(),
    }
  },
  async open(path) {
    return wrapNodeFileHandle(await openFile(path, 'r'))
  },
}

function wrapNodeFileHandle(handle: FileHandle): ArtifactFileHandle {
  return {
    async read(buffer, offset, length, position) {
      const result = await handle.read(buffer, offset, length, position)
      return { bytesRead: result.bytesRead }
    },
    async close() {
      await handle.close()
    },
  }
}

type ValidatedConfig = {
  maxInputBytes: bigint
  maxInitBytes: bigint
  maxMediaBytes: bigint
  readTimeoutMs: number
  readChunkBytes: number
  initBoxTypes: ReadonlySet<string>
  mediaBoxTypes: ReadonlySet<string>
}

function validateBoxType(type: string): string {
  if (type.length !== 4 || !/^[\x20-\x7e]{4}$/.test(type)) {
    throw new Fmp4ArtifactSourceError(
      'INVALID_CONFIG',
      'allowed box types must be four printable ASCII bytes',
    )
  }
  if (RESERVED_BOX_TYPES.has(type)) {
    throw new Fmp4ArtifactSourceError(
      'INVALID_CONFIG',
      'reserved boxes cannot be configured as auxiliary boxes',
    )
  }
  return type
}

function validateConfig(config: Fmp4ArtifactSourceConfig): ValidatedConfig {
  for (const limit of [
    config.maxInputBytes,
    config.maxInitBytes,
    config.maxMediaBytes,
  ]) {
    if (limit <= 0n || limit > MAX_SAFE_BYTES) {
      throw new Fmp4ArtifactSourceError(
        'INVALID_CONFIG',
        'byte limits must be positive safe integers',
      )
    }
  }
  if (
    !Number.isInteger(config.readTimeoutMs) ||
    config.readTimeoutMs <= 0 ||
    config.readTimeoutMs > 300_000
  ) {
    throw new Fmp4ArtifactSourceError(
      'INVALID_CONFIG',
      'read timeout must be between 1 and 300000 milliseconds',
    )
  }
  const readChunkBytes = config.readChunkBytes ?? 64 * 1024
  if (
    !Number.isInteger(readChunkBytes) ||
    readChunkBytes <= 0 ||
    readChunkBytes > 4 * 1024 * 1024
  ) {
    throw new Fmp4ArtifactSourceError(
      'INVALID_CONFIG',
      'read chunk size is invalid',
    )
  }
  return {
    maxInputBytes: config.maxInputBytes,
    maxInitBytes: config.maxInitBytes,
    maxMediaBytes: config.maxMediaBytes,
    readTimeoutMs: config.readTimeoutMs,
    readChunkBytes,
    initBoxTypes: new Set([
      ...DEFAULT_INIT_BOX_TYPES,
      ...(config.additionalInitBoxTypes ?? []).map(validateBoxType),
    ]),
    mediaBoxTypes: new Set([
      ...DEFAULT_MEDIA_BOX_TYPES,
      ...(config.additionalMediaBoxTypes ?? []).map(validateBoxType),
    ]),
  }
}

class ReadGuard {
  private readonly cancellation: Promise<never>
  private readonly timeout: ReturnType<typeof setTimeout>
  private readonly abort: (() => void) | undefined
  private rejectCancellation!: (error: Error) => void
  private stopped = false

  constructor(
    timeoutMs: number,
    private readonly signal?: AbortSignal,
  ) {
    this.cancellation = new Promise<never>((_resolve, reject) => {
      this.rejectCancellation = reject
    })
    this.abort = signal
      ? () =>
          this.stop(
            new Fmp4ArtifactSourceError('ABORTED', 'artifact read aborted'),
          )
      : undefined
    if (signal && this.abort) {
      signal.addEventListener('abort', this.abort, { once: true })
    }
    this.timeout = setTimeout(
      () =>
        this.stop(
          new Fmp4ArtifactSourceError('TIMEOUT', 'artifact read timed out'),
        ),
      timeoutMs,
    )
    if (signal?.aborted) this.abort?.()
  }

  private stop(error: Error): void {
    if (this.stopped) return
    this.stopped = true
    this.rejectCancellation(error)
  }

  async run<T>(operation: Promise<T>): Promise<T> {
    return Promise.race([operation, this.cancellation])
  }

  dispose(): void {
    clearTimeout(this.timeout)
    if (this.abort) this.signal?.removeEventListener('abort', this.abort)
  }
}

async function readExactly(
  handle: ArtifactFileHandle,
  position: number,
  length: number,
  guard: ReadGuard,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length)
  let offset = 0
  while (offset < length) {
    const result = await guard.run(
      handle.read(buffer, offset, length - offset, position + offset),
    )
    if (result.bytesRead <= 0 || result.bytesRead > length - offset) {
      throw new Fmp4ArtifactSourceError(
        'INVALID_BOX',
        'fragmented MP4 is truncated',
      )
    }
    offset += result.bytesRead
  }
  return buffer
}

type BoxHeader = {
  type: string
  size: number
  header: Buffer
}

async function readBoxHeader(
  handle: ArtifactFileHandle,
  position: number,
  fileSize: number,
  guard: ReadGuard,
): Promise<BoxHeader> {
  if (fileSize - position < 8) {
    throw new Fmp4ArtifactSourceError(
      'INVALID_BOX',
      'fragmented MP4 has a truncated box header',
    )
  }
  const base = await readExactly(handle, position, 8, guard)
  const type = base.toString('ascii', 4, 8)
  if (!/^[\x20-\x7e]{4}$/.test(type)) {
    throw new Fmp4ArtifactSourceError('INVALID_BOX', 'invalid MP4 box type')
  }
  const size32 = base.readUInt32BE(0)
  if (size32 === 0) {
    throw new Fmp4ArtifactSourceError(
      'INVALID_BOX',
      'size-zero MP4 boxes are ambiguous before EOF',
    )
  }

  let size = BigInt(size32)
  let header = base
  if (size32 === 1) {
    if (fileSize - position < 16) {
      throw new Fmp4ArtifactSourceError(
        'INVALID_BOX',
        'fragmented MP4 has a truncated extended box header',
      )
    }
    const extended = await readExactly(handle, position + 8, 8, guard)
    size = extended.readBigUInt64BE(0)
    header = Buffer.concat([base, extended])
  }
  if (size < BigInt(header.byteLength)) {
    throw new Fmp4ArtifactSourceError(
      'INVALID_BOX',
      'MP4 box size is smaller than its header',
    )
  }
  if (size > BigInt(fileSize - position) || size > MAX_SAFE_BYTES) {
    throw new Fmp4ArtifactSourceError(
      'INVALID_BOX',
      'MP4 box size exceeds the remaining input',
    )
  }
  return { type, size: Number(size), header }
}

function assertOutputLimit(
  current: bigint,
  additional: number,
  maximum: bigint,
): bigint {
  const next = current + BigInt(additional)
  if (next > maximum) {
    throw new Fmp4ArtifactSourceError(
      'OUTPUT_TOO_LARGE',
      'fragmented MP4 output exceeds its configured bound',
    )
  }
  return next
}

async function appendBox(
  target: Buffer[],
  handle: ArtifactFileHandle,
  position: number,
  box: BoxHeader,
  config: ValidatedConfig,
  guard: ReadGuard,
): Promise<void> {
  target.push(box.header)
  let remaining = box.size - box.header.byteLength
  let payloadPosition = position + box.header.byteLength
  while (remaining > 0) {
    const length = Math.min(remaining, config.readChunkBytes)
    target.push(await readExactly(handle, payloadPosition, length, guard))
    remaining -= length
    payloadPosition += length
  }
}

async function splitFragmentedMp4(
  handle: ArtifactFileHandle,
  fileSize: number,
  config: ValidatedConfig,
  guard: ReadGuard,
): Promise<ArtifactSourceBytes> {
  const initChunks: Buffer[] = []
  const mediaChunks: Buffer[] = []
  let initBytes = 0n
  let mediaBytes = 0n
  let position = 0
  let seenFtyp = false
  let seenMoov = false
  let mediaStarted = false
  let awaitingMdat = false
  let fragmentCount = 0

  while (position < fileSize) {
    const box = await readBoxHeader(handle, position, fileSize, guard)
    const payloadBytes = box.size - box.header.byteLength
    if (
      ['ftyp', 'moov', 'moof', 'mdat'].includes(box.type) &&
      payloadBytes === 0
    ) {
      throw new Fmp4ArtifactSourceError(
        'INVALID_BOX',
        `required ${box.type} box is empty`,
      )
    }

    let target: Buffer[]
    if (!mediaStarted) {
      if (position === 0 && box.type !== 'ftyp') {
        throw new Fmp4ArtifactSourceError(
          'INVALID_LAYOUT',
          'fragmented MP4 must begin with ftyp',
        )
      }
      if (box.type === 'ftyp') {
        if (seenFtyp || seenMoov) {
          throw new Fmp4ArtifactSourceError(
            'INVALID_LAYOUT',
            'ftyp must appear exactly once before moov',
          )
        }
        seenFtyp = true
        target = initChunks
      } else if (box.type === 'moov') {
        if (!seenFtyp || seenMoov) {
          throw new Fmp4ArtifactSourceError(
            'INVALID_LAYOUT',
            'moov must appear exactly once after ftyp',
          )
        }
        seenMoov = true
        target = initChunks
      } else if (config.initBoxTypes.has(box.type)) {
        target = initChunks
      } else if (box.type === 'moof' || config.mediaBoxTypes.has(box.type)) {
        if (!seenFtyp || !seenMoov) {
          throw new Fmp4ArtifactSourceError(
            'INVALID_LAYOUT',
            'media boxes require ftyp and moov initialization',
          )
        }
        mediaStarted = true
        target = mediaChunks
      } else {
        throw new Fmp4ArtifactSourceError(
          'INVALID_LAYOUT',
          'unsupported initialization box',
        )
      }
    } else {
      if (
        box.type === 'ftyp' ||
        box.type === 'moov' ||
        config.initBoxTypes.has(box.type)
      ) {
        throw new Fmp4ArtifactSourceError(
          'INVALID_LAYOUT',
          'initialization box appears after media started',
        )
      }
      target = mediaChunks
    }

    if (mediaStarted) {
      if (awaitingMdat) {
        if (box.type !== 'mdat') {
          throw new Fmp4ArtifactSourceError(
            'INVALID_LAYOUT',
            'each moof must be followed immediately by mdat',
          )
        }
        awaitingMdat = false
        fragmentCount += 1
      } else if (box.type === 'moof') {
        awaitingMdat = true
      } else if (box.type === 'mdat') {
        throw new Fmp4ArtifactSourceError(
          'INVALID_LAYOUT',
          'mdat must follow a moof box',
        )
      } else if (!config.mediaBoxTypes.has(box.type)) {
        throw new Fmp4ArtifactSourceError(
          'INVALID_LAYOUT',
          'unsupported media box',
        )
      }
    }

    if (target === initChunks) {
      initBytes = assertOutputLimit(
        initBytes,
        box.size,
        config.maxInitBytes,
      )
    } else {
      mediaBytes = assertOutputLimit(
        mediaBytes,
        box.size,
        config.maxMediaBytes,
      )
    }
    await appendBox(target, handle, position, box, config, guard)
    position += box.size
  }

  if (!seenFtyp || !seenMoov) {
    throw new Fmp4ArtifactSourceError(
      'INVALID_LAYOUT',
      'fragmented MP4 is missing required initialization boxes',
    )
  }
  if (awaitingMdat || fragmentCount === 0) {
    throw new Fmp4ArtifactSourceError(
      'INVALID_LAYOUT',
      'fragmented MP4 is missing a complete moof/mdat fragment',
    )
  }
  if (initBytes === 0n || mediaBytes === 0n) {
    throw new Fmp4ArtifactSourceError(
      'INVALID_LAYOUT',
      'fragmented MP4 outputs must be non-empty',
    )
  }
  return {
    initBytes: Buffer.concat(initChunks, Number(initBytes)),
    mediaBytes: Buffer.concat(mediaChunks, Number(mediaBytes)),
  }
}

function assertStableStat(
  stat: ArtifactFileStat,
  recording: FinalizedRecording,
): void {
  if (
    !stat.isFile ||
    stat.size !== recording.byteLength ||
    stat.mtimeNs !== recording.mtimeNs
  ) {
    throw new Fmp4ArtifactSourceError(
      'SOURCE_CHANGED',
      'finalized recording identity changed',
    )
  }
}

export class FinalizedFileArtifactSource implements ArtifactSource {
  private readonly config: ValidatedConfig

  constructor(
    config: Fmp4ArtifactSourceConfig,
    private readonly fileSystem: ArtifactFileSystem = nodeFileSystem,
  ) {
    this.config = validateConfig(config)
  }

  async read(
    recording: FinalizedRecording,
    options: ArtifactSourceReadOptions = {},
  ): Promise<ArtifactSourceBytes> {
    assertFinalizedRecording(recording)
    const expectedRecording: FinalizedRecording = { ...recording }
    if (expectedRecording.byteLength > this.config.maxInputBytes) {
      throw new Fmp4ArtifactSourceError(
        'INPUT_TOO_LARGE',
        'finalized recording exceeds the configured input bound',
      )
    }

    const guard = new ReadGuard(this.config.readTimeoutMs, options.signal)
    let handle: ArtifactFileHandle | undefined
    try {
      const before = await guard.run(
        this.fileSystem.stat(expectedRecording.trustedPath),
      )
      assertStableStat(before, expectedRecording)
      handle = await guard.run(this.fileSystem.open(expectedRecording.trustedPath))
      const outputs = await splitFragmentedMp4(
        handle,
        Number(before.size),
        this.config,
        guard,
      )
      await guard.run(handle.close())
      handle = undefined
      const after = await guard.run(
        this.fileSystem.stat(expectedRecording.trustedPath),
      )
      assertStableStat(after, expectedRecording)
      if (
        !recording.finalized ||
        recording.captureSessionId !== expectedRecording.captureSessionId ||
        recording.trustedPath !== expectedRecording.trustedPath ||
        recording.sourceIdentity !== expectedRecording.sourceIdentity ||
        recording.byteLength !== expectedRecording.byteLength ||
        recording.mtimeNs !== expectedRecording.mtimeNs ||
        after.device !== before.device ||
        after.inode !== before.inode
      ) {
        throw new Fmp4ArtifactSourceError(
          'SOURCE_CHANGED',
          'finalized recording identity changed',
        )
      }
      return outputs
    } catch (error) {
      if (error instanceof Fmp4ArtifactSourceError) throw error
      throw new Fmp4ArtifactSourceError(
        'INVALID_BOX',
        'failed to read finalized fragmented MP4',
        { cause: error },
      )
    } finally {
      guard.dispose()
      if (handle) {
        try {
          await handle.close()
        } catch {
          // Preserve the primary read/validation failure.
        }
      }
    }
  }
}
