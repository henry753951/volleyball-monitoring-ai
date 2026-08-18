import { createHash } from 'node:crypto'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { dirname, extname, relative, resolve, sep } from 'node:path'
import { z } from 'zod'

export const MEDIA_INGEST_QUEUE = 'media.ingest.finalized.v1' as const
const SUPPORTED_EXTENSIONS = new Set(['.mp4', '.m4s', '.fmp4'])
const CANONICAL_UNSIGNED_DECIMAL = /^(?:0|[1-9][0-9]*)$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const RECORDING_TIMESTAMP =
  /(?:^|\/)(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?:-(\d{6})|_(\d+))(?:\.[^.]+)$/
const OME_RECORDING_TIMESTAMP =
  /(?:^|\/)(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_(\d+)(?:\.[^.]+)$/
const SOURCE_RESTART_MARKER =
  /(?:^|\/)\.source-restart-(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})-(\d{6})\.marker$/

export const MediaIngestEnvelope = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    jobType: z.literal(MEDIA_INGEST_QUEUE),
    captureSessionId: z.string().regex(UUID),
    candidate: z.string(),
    sourceOrder: z.string().regex(CANONICAL_UNSIGNED_DECIMAL),
    epochCandidateId: z.string().regex(UUID),
    sourceRestart: z.boolean(),
    timestampDiscontinuity: z.boolean(),
    explicitGapBeforeUs: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .nullable(),
  })
  .strict()

export type MediaIngestEnvelope = z.infer<typeof MediaIngestEnvelope>

export function canonicalCandidate(value: string): string {
  if (!value || value.includes('\0') || value.includes('\\') || value.startsWith('/')) {
    throw new Error('invalid spool candidate')
  }
  const parts = value.split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error('invalid spool candidate')
  }
  if (!SUPPORTED_EXTENSIONS.has(extname(value).toLowerCase())) {
    throw new Error('unsupported recording extension')
  }
  return parts.join('/')
}

function uuidFromDigest(input: string): string {
  const bytes = createHash('sha256').update(input).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function epochCandidateId(captureSessionId: string, candidate: string): string {
  if (!UUID.test(captureSessionId)) throw new Error('invalid capture session id')
  return uuidFromDigest(
    `volleyball-media-epoch-candidate-v1\0${captureSessionId}\0${canonicalCandidate(candidate)}`,
  )
}

function sourceOrderFromTimestampMatch(match: RegExpExecArray | null): string {
  if (!match) throw new Error('invalid recording timestamp')
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  const micros = match[7] === undefined ? Number(match[8]!) : Number(match[7])
  if (
    year < 1970 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    micros < 0 ||
    micros > 999_999
  ) {
    throw new Error('invalid recorder segment timestamp')
  }
  const timestampMs = Date.UTC(year, month - 1, day, hour, minute, second)
  const date = new Date(timestampMs)
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    throw new Error('invalid recorder segment timestamp')
  }
  return (BigInt(timestampMs) * 1_000n + BigInt(micros)).toString()
}

export function sourceOrderFromCandidate(candidateValue: string): string {
  const candidate = canonicalCandidate(candidateValue)
  return sourceOrderFromTimestampMatch(
    RECORDING_TIMESTAMP.exec(candidate) ?? OME_RECORDING_TIMESTAMP.exec(candidate),
  )
}

export function sourceOrderFromRestartMarker(markerValue: string): string {
  const marker = markerValue.replaceAll('\\', '/')
  if (
    !marker ||
    marker.startsWith('/') ||
    marker.split('/').some(part => !part || part === '.' || part === '..')
  ) {
    throw new Error('invalid source restart marker')
  }
  return sourceOrderFromTimestampMatch(SOURCE_RESTART_MARKER.exec(marker))
}

export function createEnvelope(
  input: Omit<MediaIngestEnvelope, 'epochCandidateId' | 'candidate'> & {
    candidate: string
  },
): MediaIngestEnvelope {
  const candidate = canonicalCandidate(input.candidate)
  return MediaIngestEnvelope.parse({
    ...input,
    candidate,
    epochCandidateId: epochCandidateId(input.captureSessionId, candidate),
  })
}

export async function scanSpool(
  root: string,
  resolveCapture: (ingestPath: string) => Promise<string | null>,
): Promise<MediaIngestEnvelope[]> {
  const trustedRoot = await realpath(root)
  const files: string[] = []
  const markers: string[] = []

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) {
        if (SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) files.push(path)
        else if (SOURCE_RESTART_MARKER.test(entry.name)) markers.push(path)
      }
    }
  }

  await visit(trustedRoot)
  const restartOrders = new Map<string, bigint[]>()
  for (const path of markers) {
    const canonicalPath = await realpath(path)
    const relativePath = relative(trustedRoot, canonicalPath)
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`)) continue
    const marker = relativePath.replaceAll(sep, '/')
    let order: bigint
    try {
      order = BigInt(sourceOrderFromRestartMarker(marker))
    } catch {
      continue
    }
    const ingestPath = dirname(marker).replaceAll('\\', '/')
    const orders = restartOrders.get(ingestPath) ?? []
    orders.push(order)
    restartOrders.set(ingestPath, orders)
  }

  const discovered: Array<{ ingestPath: string; envelope: MediaIngestEnvelope }> = []
  for (const path of files) {
    const canonicalPath = await realpath(path)
    const relativePath = relative(trustedRoot, canonicalPath)
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`)) continue

    const candidate = canonicalCandidate(relativePath.replaceAll(sep, '/'))
    const metadata = await stat(canonicalPath, { bigint: true })
    if (!metadata.isFile() || metadata.size === 0n) continue

    const separator = candidate.lastIndexOf('/')
    if (separator <= 0) continue
    let sourceOrder: string
    try {
      sourceOrder = sourceOrderFromCandidate(candidate)
    } catch {
      continue
    }
    const captureSessionId = await resolveCapture(candidate.slice(0, separator))
    if (!captureSessionId || !UUID.test(captureSessionId)) continue
    discovered.push({
      ingestPath: candidate.slice(0, separator),
      envelope: createEnvelope({
        schemaVersion: '1.0.0',
        jobType: MEDIA_INGEST_QUEUE,
        captureSessionId,
        candidate,
        sourceOrder,
        sourceRestart: false,
        timestampDiscontinuity: false,
        explicitGapBeforeUs: null,
      }),
    })
  }

  discovered.sort((left, right) => {
    const captureOrder = left.envelope.captureSessionId.localeCompare(
      right.envelope.captureSessionId,
    )
    if (captureOrder !== 0) return captureOrder
    const leftOrder = BigInt(left.envelope.sourceOrder)
    const rightOrder = BigInt(right.envelope.sourceOrder)
    if (leftOrder !== rightOrder) return leftOrder < rightOrder ? -1 : 1
    return left.envelope.candidate.localeCompare(right.envelope.candidate)
  })

  const restartCandidates = new Set<string>()
  for (const [ingestPath, orders] of restartOrders) {
    const candidates = discovered.filter(item => item.ingestPath === ingestPath)
    for (const markerOrder of orders) {
      const first = candidates.find(item => BigInt(item.envelope.sourceOrder) > markerOrder)
      if (first) restartCandidates.add(first.envelope.candidate)
    }
  }

  return discovered
    .map(({ envelope }) =>
      restartCandidates.has(envelope.candidate) ? { ...envelope, sourceRestart: true } : envelope,
    )
    .sort((left, right) => {
      const captureOrder = left.captureSessionId.localeCompare(right.captureSessionId)
      if (captureOrder !== 0) return captureOrder
      const leftOrder = BigInt(left.sourceOrder)
      const rightOrder = BigInt(right.sourceOrder)
      if (leftOrder !== rightOrder) return leftOrder < rightOrder ? -1 : 1
      return left.candidate.localeCompare(right.candidate)
    })
}

function withinRoot(root: string, path: string): boolean {
  const child = relative(root, path)
  return Boolean(child) && child !== '..' && !child.startsWith(`..${sep}`)
}

async function sourceRestartForCandidate(
  trustedRoot: string,
  candidate: string,
  candidateOrder: bigint,
): Promise<boolean> {
  const ingestPath = dirname(candidate).replaceAll('\\', '/')
  const directory = resolve(trustedRoot, ingestPath)
  const entries = await readdir(directory, { withFileTypes: true })
  const mediaOrders = entries
    .filter(entry => entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .flatMap(entry => {
      try {
        return [BigInt(sourceOrderFromCandidate(`${ingestPath}/${entry.name}`))]
      } catch {
        return []
      }
    })
  for (const entry of entries) {
    if (!entry.isFile() || !SOURCE_RESTART_MARKER.test(entry.name)) continue
    let markerOrder: bigint
    try {
      markerOrder = BigInt(sourceOrderFromRestartMarker(`${ingestPath}/${entry.name}`))
    } catch {
      continue
    }
    const firstAfterMarker = mediaOrders
      .filter(order => order > markerOrder)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))[0]
    if (firstAfterMarker === candidateOrder) return true
  }
  return false
}

/** Resolve one finalized media event without walking unrelated capture directories. */
export async function scanSpoolCandidate(
  root: string,
  candidateValue: string,
  resolveCapture: (ingestPath: string) => Promise<string | null>,
): Promise<MediaIngestEnvelope | null> {
  const candidate = canonicalCandidate(candidateValue.replaceAll(sep, '/'))
  const trustedRoot = await realpath(root)
  let trustedPath: string
  try {
    trustedPath = await realpath(resolve(trustedRoot, candidate))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (!withinRoot(trustedRoot, trustedPath)) return null
  const metadata = await stat(trustedPath, { bigint: true })
  if (!metadata.isFile() || metadata.size === 0n) return null
  const separator = candidate.lastIndexOf('/')
  if (separator <= 0) return null
  const ingestPath = candidate.slice(0, separator)
  let sourceOrder: string
  try {
    sourceOrder = sourceOrderFromCandidate(candidate)
  } catch {
    return null
  }
  const captureSessionId = await resolveCapture(ingestPath)
  if (!captureSessionId || !UUID.test(captureSessionId)) return null
  return createEnvelope({
    schemaVersion: '1.0.0',
    jobType: MEDIA_INGEST_QUEUE,
    captureSessionId,
    candidate,
    sourceOrder,
    sourceRestart: await sourceRestartForCandidate(trustedRoot, candidate, BigInt(sourceOrder)),
    timestampDiscontinuity: false,
    explicitGapBeforeUs: null,
  })
}

export type ActiveCaptureDirectory = {
  captureSessionId: string
  ingestPath: string
}

/** Poll one known active capture directory without recursively walking the spool root. */
export async function scanActiveCaptureDirectory(
  root: string,
  capture: ActiveCaptureDirectory,
): Promise<MediaIngestEnvelope[]> {
  if (!UUID.test(capture.captureSessionId)) throw new Error('invalid capture session id')
  const ingestPath = capture.ingestPath.replaceAll('\\', '/')
  if (
    !ingestPath ||
    ingestPath.startsWith('/') ||
    ingestPath.split('/').some(part => !part || part === '.' || part === '..')
  ) {
    throw new Error('invalid capture ingest path')
  }
  const trustedRoot = await realpath(root)
  let trustedDirectory: string
  try {
    trustedDirectory = await realpath(resolve(trustedRoot, ingestPath))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  if (!withinRoot(trustedRoot, trustedDirectory)) return []
  const entries = await readdir(trustedDirectory, { withFileTypes: true })
  const media = entries
    .filter(entry => entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .flatMap(entry => {
      const candidate = `${ingestPath}/${entry.name}`
      try {
        return [{ candidate, sourceOrder: BigInt(sourceOrderFromCandidate(candidate)) }]
      } catch {
        return []
      }
    })
    .sort((left, right) =>
      left.sourceOrder < right.sourceOrder ? -1 : left.sourceOrder > right.sourceOrder ? 1 : 0,
    )
  const restartCandidates = new Set<string>()
  for (const entry of entries) {
    if (!entry.isFile() || !SOURCE_RESTART_MARKER.test(entry.name)) continue
    let markerOrder: bigint
    try {
      markerOrder = BigInt(sourceOrderFromRestartMarker(`${ingestPath}/${entry.name}`))
    } catch {
      continue
    }
    const first = media.find(item => item.sourceOrder > markerOrder)
    if (first) restartCandidates.add(first.candidate)
  }
  return media.map(item =>
    createEnvelope({
      schemaVersion: '1.0.0',
      jobType: MEDIA_INGEST_QUEUE,
      captureSessionId: capture.captureSessionId,
      candidate: item.candidate,
      sourceOrder: item.sourceOrder.toString(),
      sourceRestart: restartCandidates.has(item.candidate),
      timestampDiscontinuity: false,
      explicitGapBeforeUs: null,
    }),
  )
}

/** Read OME's finalized extent metadata; paths outside that recording directory are ignored. */
export async function recordingInfoCandidates(
  root: string,
  infoPathValue: string,
): Promise<string[]> {
  const normalized = infoPathValue.replaceAll(sep, '/')
  if (
    !normalized ||
    normalized.includes('\\') ||
    normalized.startsWith('/') ||
    normalized.split('/').some(part => !part || part === '.' || part === '..') ||
    normalized.split('/').at(-1)?.toLowerCase() !== 'recording.xml'
  ) {
    return []
  }
  const trustedRoot = await realpath(root)
  let trustedInfoPath: string
  try {
    trustedInfoPath = await realpath(resolve(trustedRoot, normalized))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  if (!withinRoot(trustedRoot, trustedInfoPath)) return []
  const ingestPath = dirname(normalized).replaceAll('\\', '/')
  const xml = await readFile(trustedInfoPath, 'utf8')
  const candidates = new Set<string>()
  for (const match of xml.matchAll(/<filePath>\s*<!\[CDATA\[([^\]]+)\]\]>\s*<\/filePath>/g)) {
    const raw = match[1]?.replace(/^\/+/, '')
    if (!raw) continue
    let candidate: string
    try {
      candidate = canonicalCandidate(raw)
    } catch {
      continue
    }
    if (dirname(candidate).replaceAll('\\', '/') === ingestPath) candidates.add(candidate)
  }
  return [...candidates]
}

export type IngestQueue = {
  send(
    name: string,
    payload: MediaIngestEnvelope,
    options?: Record<string, unknown>,
  ): Promise<unknown>
}

export async function enqueueUnique(
  queue: IngestQueue,
  envelopeValue: MediaIngestEnvelope,
): Promise<void> {
  const envelope = MediaIngestEnvelope.parse(envelopeValue)
  await queue.send(MEDIA_INGEST_QUEUE, envelope, {
    singletonKey: envelope.captureSessionId,
  })
}
