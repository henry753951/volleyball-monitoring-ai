import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { sha256, type ArtifactMetadata, type MediaArtifact } from './artifacts.js'
import type { MediaObjectStore } from './ingest.js'

type PendingArchive = {
  schemaVersion: '1.0.0'
  kind: ArtifactMetadata['kind']
  bucket: string
  key: string
  contentType: ArtifactMetadata['contentType']
  byteLength: string
  sha256: string
  internalSchemaVersion: ArtifactMetadata['internalSchemaVersion']
}

export type TieredMediaObjectStoreConfig = {
  root: string
  archive: MediaObjectStore
  archiveConcurrency?: number
}

function safePath(rootValue: string, bucket: string, key: string): string {
  if (
    !bucket ||
    bucket.includes('/') ||
    bucket.includes('\\') ||
    !key ||
    key.startsWith('/') ||
    key.includes('\\') ||
    key.includes('\0') ||
    key.split('/').some(part => !part || part === '.' || part === '..')
  ) {
    throw new Error('Hot media object location is invalid')
  }
  const root = resolve(rootValue)
  const target = resolve(root, bucket, ...key.split('/'))
  const relation = relative(root, target)
  if (!relation || relation.startsWith('..') || isAbsolute(relation)) {
    throw new Error('Hot media object escapes its configured root')
  }
  return target
}

function pendingPath(path: string): string {
  return `${path}.archive-pending.json`
}

function pendingDocument(artifact: ArtifactMetadata): PendingArchive {
  return {
    schemaVersion: '1.0.0',
    kind: artifact.kind,
    bucket: artifact.location.bucket,
    key: artifact.location.key,
    contentType: artifact.contentType,
    byteLength: artifact.byteLength.toString(),
    sha256: artifact.sha256,
    internalSchemaVersion: artifact.internalSchemaVersion,
  }
}

function parsePending(value: string): PendingArchive {
  const parsed = JSON.parse(value) as Partial<PendingArchive>
  if (
    parsed.schemaVersion !== '1.0.0' ||
    !['init', 'media', 'sample-index'].includes(parsed.kind ?? '') ||
    typeof parsed.bucket !== 'string' ||
    typeof parsed.key !== 'string' ||
    !['video/mp4', 'application/json'].includes(parsed.contentType ?? '') ||
    typeof parsed.byteLength !== 'string' ||
    !/^[1-9][0-9]*$/.test(parsed.byteLength) ||
    typeof parsed.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(parsed.sha256) ||
    parsed.internalSchemaVersion !== '1.0.0'
  ) {
    throw new Error('Hot media archive receipt is invalid')
  }
  return parsed as PendingArchive
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.part`
  try {
    await writeFile(temporary, bytes, { flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function verifiedBytes(path: string, artifact: ArtifactMetadata): Promise<Buffer> {
  const metadata = await stat(path)
  if (!metadata.isFile() || BigInt(metadata.size) !== artifact.byteLength) {
    throw new Error('Hot media object length does not match its immutable metadata')
  }
  const bytes = await readFile(path)
  if (sha256(bytes) !== artifact.sha256) {
    throw new Error('Hot media object checksum does not match its immutable metadata')
  }
  return bytes
}

async function pendingFiles(root: string): Promise<string[]> {
  const result: string[] = []
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && entry.name.endsWith('.archive-pending.json')) result.push(path)
    }
  }
  await visit(root)
  return result
}

export class TieredMediaObjectStore implements MediaObjectStore {
  readonly #root: string
  readonly #archive: MediaObjectStore
  readonly #concurrency: number
  readonly #queued = new Set<string>()
  readonly #active = new Set<Promise<void>>()
  #started = false
  #lastErrorAt: string | null = null
  #lastSuccessAt: string | null = null

  constructor(config: TieredMediaObjectStoreConfig) {
    const concurrency = config.archiveConcurrency ?? 8
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
      throw new TypeError('archiveConcurrency must be between 1 and 32')
    }
    this.#root = resolve(config.root)
    this.#archive = config.archive
    this.#concurrency = concurrency
  }

  get snapshot() {
    return {
      pending: this.#queued.size + this.#active.size,
      lastErrorAt: this.#lastErrorAt,
      lastSuccessAt: this.#lastSuccessAt,
    }
  }

  async start(): Promise<void> {
    if (this.#started) return
    this.#started = true
    await mkdir(this.#root, { recursive: true })
    for (const path of await pendingFiles(this.#root)) this.#schedule(path)
  }

  async stop(): Promise<void> {
    this.#started = false
    await Promise.allSettled([...this.#active])
  }

  async upload(artifact: MediaArtifact): Promise<void> {
    if (
      BigInt(artifact.bytes.byteLength) !== artifact.byteLength ||
      sha256(artifact.bytes) !== artifact.sha256
    ) {
      throw new Error('Hot media artifact bytes do not match metadata')
    }
    const path = safePath(this.#root, artifact.location.bucket, artifact.location.key)
    try {
      await verifiedBytes(path, artifact)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await atomicWrite(path, artifact.bytes)
    }
    const receipt = Buffer.from(JSON.stringify(pendingDocument(artifact)), 'utf8')
    await atomicWrite(pendingPath(path), receipt)
    this.#schedule(pendingPath(path))
  }

  async verify(artifact: ArtifactMetadata): Promise<void> {
    await verifiedBytes(
      safePath(this.#root, artifact.location.bucket, artifact.location.key),
      artifact,
    )
  }

  #schedule(path: string): void {
    if (this.#queued.has(path)) return
    this.#queued.add(path)
    this.#drain()
  }

  #drain(): void {
    if (!this.#started) return
    while (this.#active.size < this.#concurrency) {
      const path = this.#queued.values().next().value as string | undefined
      if (!path) return
      this.#queued.delete(path)
      let task: Promise<void>
      task = this.#archiveOne(path)
        .catch(() => {
          this.#lastErrorAt = new Date().toISOString()
          if (this.#started) setTimeout(() => this.#schedule(path), 2_000)
        })
        .finally(() => {
          this.#active.delete(task)
          if (this.#started) setTimeout(() => this.#drain(), 250)
        })
      this.#active.add(task)
    }
  }

  async #archiveOne(receiptPath: string): Promise<void> {
    const receipt = parsePending(await readFile(receiptPath, 'utf8'))
    const metadata: ArtifactMetadata = {
      kind: receipt.kind,
      location: { bucket: receipt.bucket, key: receipt.key },
      contentType: receipt.contentType,
      byteLength: BigInt(receipt.byteLength),
      sha256: receipt.sha256,
      internalSchemaVersion: receipt.internalSchemaVersion,
    }
    const bytes = await verifiedBytes(safePath(this.#root, receipt.bucket, receipt.key), metadata)
    await this.#archive.upload({ ...metadata, bytes })
    await this.#archive.verify(metadata)
    await rm(receiptPath, { force: true })
    this.#lastSuccessAt = new Date().toISOString()
    this.#lastErrorAt = null
  }
}

export function createTieredMediaObjectStore(config: TieredMediaObjectStoreConfig) {
  return new TieredMediaObjectStore(config)
}
