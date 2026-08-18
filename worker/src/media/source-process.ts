import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { ClaimedMediaSourceWork, SourceCompletion } from './source-work.js'

type ProcessResult = { stderr: Buffer; stdout: Buffer }

export type MediaSourceProcessOptions = {
  importRoot: string
  ingestBaseUrl: string
  recordingRoot: string
  workRoot: string
  youtubeCookiesFile?: string
  youtubeJsRuntime?: 'deno' | 'node'
  youtubeUseCookies?: boolean
  youtubeExtractorArgs: string
  youtubeFormat: string
  youtubeLiveExtractorArgs?: string
  youtubeLiveMaxConsecutiveFailures?: number
  youtubePotProviderUrl?: string
  youtubeVodExtractorArgs?: string
  youtubeVodFormat: string
  ytDlpCommand?: string
  ffmpegCommand?: string
  ffprobeCommand?: string
  recordingExtentSeconds?: number
}

type MediaInput = {
  httpHeaders?: Record<string, string>
  httpChunkSize?: number
  url: string
}

const MEDIA_SEGMENT_DURATION_US = 2_000_000n
const DEFAULT_RECORDING_EXTENT_SECONDS = 60
const VOD_COMPLETION_MIN_TOLERANCE_US = 5_000_000n
const YOUTUBE_PREFLIGHT_RANGE_BYTES = 64 * 1024
const LIVE_RELAY_PROGRESS_TIMEOUT_MS = 20_000
const LOCAL_CHECKPOINT_FILE = '.source-checkpoint-v1.json'
const LOCAL_PENDING_CHECKPOINT_FILE = '.source-checkpoint-v1.pending.json'

export type MediaSourceProcessObserver = {
  classified(value: Pick<SourceCompletion, 'sourceDurationUs' | 'sourceKind'>): Promise<void>
  retrying?(code: string): Promise<void>
  resumed(segmentIndex: number, captureTimeUs: bigint): Promise<void>
}

export class MediaSourceProcessError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'MediaSourceProcessError'
  }
}

function abortError(): Error {
  return new DOMException('The media source was stopped', 'AbortError')
}

function boundedMessage(value: Buffer): string {
  return value
    .subarray(Math.max(0, value.length - 1_024))
    .toString('utf8')
    .replace(/[\r\n]+/g, ' ')
    .trim()
}

export function latestFfmpegProgressUs(value: string): bigint | null {
  let latest: bigint | null = null
  for (const match of value.matchAll(/^out_time_us=(\d+)$/gm)) latest = BigInt(match[1]!)
  return latest
}

async function runProcess(
  command: string,
  args: string[],
  signal: AbortSignal,
  maxOutputBytes = 16 * 1024 * 1024,
  mediaProgressTimeoutMs = 0,
): Promise<ProcessResult> {
  if (signal.aborted) throw abortError()
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let outputBytes = 0
  let mediaProgressTimer: ReturnType<typeof setTimeout> | null = null
  let mediaProgressText = ''
  let mediaProgressUs = -1n
  let mediaStalled = false
  const armMediaProgressTimer = () => {
    if (mediaProgressTimer) clearTimeout(mediaProgressTimer)
    if (mediaProgressTimeoutMs <= 0) return
    mediaProgressTimer = setTimeout(() => {
      mediaStalled = true
      child.kill('SIGKILL')
    }, mediaProgressTimeoutMs)
  }
  const collect = (target: Buffer[], chunk: Buffer) => {
    outputBytes += chunk.length
    if (outputBytes > maxOutputBytes) child.kill('SIGKILL')
    else target.push(chunk)
  }
  child.stdout?.on('data', chunk => {
    const value = Buffer.from(chunk)
    if (mediaProgressTimeoutMs <= 0) {
      collect(stdout, value)
      return
    }
    mediaProgressText = `${mediaProgressText}${value.toString('utf8')}`.slice(-4_096)
    const progressUs = latestFfmpegProgressUs(mediaProgressText)
    if (progressUs !== null && progressUs > mediaProgressUs) {
      mediaProgressUs = progressUs
      armMediaProgressTimer()
    }
  })
  child.stderr?.on('data', chunk => collect(stderr, Buffer.from(chunk)))
  armMediaProgressTimer()
  const abort = () => child.kill('SIGTERM')
  signal.addEventListener('abort', abort, { once: true })
  try {
    const code = await new Promise<number>((resolvePromise, reject) => {
      child.once('error', reject)
      child.once('close', value => resolvePromise(value ?? -1))
    })
    if (signal.aborted) throw abortError()
    const result = { stderr: Buffer.concat(stderr), stdout: Buffer.concat(stdout) }
    if (mediaStalled)
      throw new MediaSourceProcessError(
        'MEDIA_SOURCE_STALLED',
        `Media source made no timestamp progress for ${mediaProgressTimeoutMs} ms`,
      )
    if (outputBytes > maxOutputBytes)
      throw new MediaSourceProcessError(
        'PROCESS_OUTPUT_LIMIT',
        'Media command produced too much output',
      )
    if (code !== 0)
      throw new MediaSourceProcessError(
        'MEDIA_COMMAND_FAILED',
        boundedMessage(result.stderr) || `Media command exited ${code}`,
      )
    return result
  } finally {
    if (mediaProgressTimer) clearTimeout(mediaProgressTimer)
    signal.removeEventListener('abort', abort)
  }
}

function safeChild(rootValue: string, childValue: string): string {
  const root = resolve(rootValue)
  const target = isAbsolute(childValue) ? resolve(childValue) : resolve(root, childValue)
  const relation = relative(root, target)
  if (!relation || relation.startsWith('..') || isAbsolute(relation))
    throw new MediaSourceProcessError(
      'INVALID_MEDIA_PATH',
      'Media path escapes its configured root',
    )
  return target
}

export function recordingExtentSeconds(options: MediaSourceProcessOptions): number {
  const value = options.recordingExtentSeconds ?? DEFAULT_RECORDING_EXTENT_SECONDS
  if (!Number.isInteger(value) || value < 15 || value > 300) {
    throw new MediaSourceProcessError(
      'INVALID_RECORDING_EXTENT',
      'Recording extent must be an integer between 15 and 300 seconds',
    )
  }
  return value
}

export function recordingExtentFilename(base: Date, captureStartUs: bigint): string {
  if (!Number.isFinite(base.getTime()) || captureStartUs < 0n) {
    throw new MediaSourceProcessError('INVALID_RECORDING_TIME', 'Recording time is invalid')
  }
  const timestampUs = BigInt(base.getTime()) * 1_000n + captureStartUs
  const value = new Date(Number(timestampUs / 1_000n))
  const date = value.toISOString().slice(0, 19).replace('T', '_').replaceAll(':', '-')
  const micros = timestampUs % 1_000_000n
  return `${date}-${micros.toString().padStart(6, '0')}.mp4`
}

export type SegmentListTiming = {
  startUs: bigint
  endUs: bigint
}

export function segmentListTiming(content: string, segmentName: string): SegmentListTiming | null {
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue
    const fields = line.split(',')
    if (fields.length < 3) continue
    const end = Number(fields.pop()!)
    const start = Number(fields.pop()!)
    const rawPath = fields.join(',').trim().replace(/^"|"$/g, '').replaceAll('\\', '/')
    if (!rawPath.endsWith(`/${segmentName}`) && rawPath !== segmentName) continue
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return null
    return {
      startUs: BigInt(Math.round(start * 1_000_000)),
      endUs: BigInt(Math.round(end * 1_000_000)),
    }
  }
  return null
}

async function readSegmentTiming(
  listPath: string,
  segmentName: string,
): Promise<SegmentListTiming | null> {
  const content = await readFile(listPath, 'utf8').catch(() => '')
  return segmentListTiming(content, segmentName)
}

type LocalRecordingCheckpoint = {
  schemaVersion: 1
  segmentIndex: number
  captureTimeUs: string
  targetName: string
}

function parseLocalCheckpoint(value: unknown): LocalRecordingCheckpoint | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (
    candidate.schemaVersion !== 1 ||
    !Number.isSafeInteger(candidate.segmentIndex) ||
    Number(candidate.segmentIndex) < 1 ||
    typeof candidate.captureTimeUs !== 'string' ||
    !/^[1-9][0-9]*$/.test(candidate.captureTimeUs) ||
    typeof candidate.targetName !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{6}\.mp4$/.test(candidate.targetName)
  ) {
    return null
  }
  return candidate as LocalRecordingCheckpoint
}

async function readLocalCheckpoint(path: string): Promise<LocalRecordingCheckpoint | null> {
  try {
    const checkpoint = parseLocalCheckpoint(JSON.parse(await readFile(path, 'utf8')))
    if (!checkpoint) throw new Error('invalid checkpoint payload')
    return checkpoint
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new MediaSourceProcessError(
      'MEDIA_CHECKPOINT_INVALID',
      'Recording checkpoint is unreadable',
    )
  }
}

async function writeJsonAtomic(path: string, value: LocalRecordingCheckpoint): Promise<void> {
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'w' })
  await rename(temporary, path)
}

async function recoverLocalCheckpoint(
  destination: string,
): Promise<LocalRecordingCheckpoint | null> {
  const checkpointPath = join(destination, LOCAL_CHECKPOINT_FILE)
  const pendingPath = join(destination, LOCAL_PENDING_CHECKPOINT_FILE)
  let committed = await readLocalCheckpoint(checkpointPath)
  const pending = await readLocalCheckpoint(pendingPath)
  if (!pending) return committed
  const target = join(destination, pending.targetName)
  const metadata = await stat(target).catch(() => null)
  if (metadata?.isFile() && metadata.size > 0) {
    if (
      committed &&
      (pending.segmentIndex < committed.segmentIndex ||
        BigInt(pending.captureTimeUs) < BigInt(committed.captureTimeUs))
    ) {
      throw new MediaSourceProcessError(
        'MEDIA_CHECKPOINT_CONFLICT',
        'Pending recording checkpoint regresses committed progress',
      )
    }
    await writeJsonAtomic(checkpointPath, pending)
    committed = pending
  }
  await rm(pendingPath, { force: true })
  return committed
}

function mergeCheckpoint(
  work: ClaimedMediaSourceWork,
  local: LocalRecordingCheckpoint | null,
): { segmentIndex: number; captureTimeUs: bigint } {
  if (!local) {
    return {
      segmentIndex: work.resumeSegmentIndex,
      captureTimeUs: work.resumeCaptureTimeUs,
    }
  }
  const localCaptureTimeUs = BigInt(local.captureTimeUs)
  const localAhead =
    local.segmentIndex >= work.resumeSegmentIndex && localCaptureTimeUs >= work.resumeCaptureTimeUs
  const databaseAhead =
    local.segmentIndex <= work.resumeSegmentIndex && localCaptureTimeUs <= work.resumeCaptureTimeUs
  if (!localAhead && !databaseAhead) {
    throw new MediaSourceProcessError(
      'MEDIA_CHECKPOINT_CONFLICT',
      'Recording checkpoint and database progress disagree',
    )
  }
  return localAhead
    ? { segmentIndex: local.segmentIndex, captureTimeUs: localCaptureTimeUs }
    : { segmentIndex: work.resumeSegmentIndex, captureTimeUs: work.resumeCaptureTimeUs }
}

async function probeFile(
  path: string,
  options: MediaSourceProcessOptions,
  signal: AbortSignal,
): Promise<{ codec: string; durationUs: bigint | null }> {
  const result = await runProcess(
    options.ffprobeCommand ?? 'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name:format=duration',
      '-of',
      'json',
      path,
    ],
    signal,
  )
  const value = JSON.parse(result.stdout.toString('utf8')) as {
    format?: { duration?: string }
    streams?: Array<{ codec_name?: string }>
  }
  const seconds = Number(value.format?.duration)
  return {
    codec: value.streams?.[0]?.codec_name?.toLowerCase() ?? '',
    durationUs:
      Number.isFinite(seconds) && seconds > 0 ? BigInt(Math.round(seconds * 1_000_000)) : null,
  }
}

async function waitForChild(child: ChildProcess): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('close', code => resolvePromise(code ?? -1))
  })
}

export function buildMediaInputArgs(
  input: MediaInput,
  realtime: boolean,
  seekSeconds: number,
): string[] {
  const headers = Object.entries(input.httpHeaders ?? {})
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join('')
  const chunkSize = input.httpChunkSize
  return [
    ...(seekSeconds > 0 ? ['-ss', seekSeconds.toFixed(6)] : []),
    ...(chunkSize
      ? [
          '-request_size',
          String(chunkSize),
          '-initial_request_size',
          String(chunkSize),
          '-multiple_requests',
          '1',
          '-short_seek_size',
          String(chunkSize),
        ]
      : []),
    ...(headers ? ['-headers', headers] : []),
    ...(realtime ? ['-re'] : []),
    '-i',
    input.url,
  ]
}

export function vodCompletionToleranceUs(segmentDurationUs = MEDIA_SEGMENT_DURATION_US): bigint {
  const twoSegmentsUs = segmentDurationUs * 2n
  return twoSegmentsUs > VOD_COMPLETION_MIN_TOLERANCE_US
    ? twoSegmentsUs
    : VOD_COMPLETION_MIN_TOLERANCE_US
}

export function reachedExpectedMediaEnd(
  publishedCaptureTimeUs: bigint,
  expectedDurationUs: bigint | null,
  segmentDurationUs = MEDIA_SEGMENT_DURATION_US,
): boolean {
  return (
    expectedDurationUs === null ||
    publishedCaptureTimeUs + vodCompletionToleranceUs(segmentDurationUs) >= expectedDurationUs
  )
}

async function segmentInputs(
  work: ClaimedMediaSourceWork,
  inputs: readonly MediaInput[],
  options: MediaSourceProcessOptions,
  observer: MediaSourceProcessObserver,
  signal: AbortSignal,
  codec: string,
  expectedDurationUs: bigint | null = null,
  realtime = false,
): Promise<number> {
  if (inputs.length < 1 || inputs.length > 2)
    throw new MediaSourceProcessError(
      'YOUTUBE_INPUT_COUNT',
      'Media source returned an unsupported input layout',
    )
  const destination = safeChild(options.recordingRoot, work.ingestPath)
  // Keep staging on the recording filesystem. A finalized extent can then be
  // published with one atomic rename instead of a full cross-directory copy.
  const workspace = safeChild(destination, `.source-work/${work.id}`)
  const segments = join(workspace, 'segments')
  const segmentList = join(workspace, 'segments.csv')
  await mkdir(destination, { recursive: true })
  const localCheckpoint = await recoverLocalCheckpoint(destination)
  const resume = mergeCheckpoint(work, localCheckpoint)
  if (
    resume.segmentIndex > work.resumeSegmentIndex ||
    resume.captureTimeUs > work.resumeCaptureTimeUs
  ) {
    await observer.resumed(resume.segmentIndex, resume.captureTimeUs)
  }
  if (
    resume.segmentIndex > 0 &&
    expectedDurationUs !== null &&
    reachedExpectedMediaEnd(resume.captureTimeUs, expectedDurationUs)
  ) {
    return resume.segmentIndex
  }
  await rm(workspace, { force: true, recursive: true })
  await mkdir(segments, { recursive: true })
  let published = resume.segmentIndex
  const startPublished = published
  let publishedCaptureTimeUs = resume.captureTimeUs
  const seekSeconds = Number(resume.captureTimeUs) / 1_000_000
  const extentSeconds = recordingExtentSeconds(options)
  const videoCodec =
    codec === 'h264' || codec.startsWith('avc')
      ? ['-c:v', 'copy']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p']
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'warning']
  for (const input of inputs) args.push(...buildMediaInputArgs(input, realtime, seekSeconds))
  args.push(
    '-map',
    '0:v:0',
    '-map',
    inputs.length === 1 ? '0:a:0?' : '1:a:0',
    ...videoCodec,
    '-c:a',
    'aac',
    '-f',
    'segment',
    '-segment_time',
    String(extentSeconds),
    '-reset_timestamps',
    '1',
    '-segment_format',
    'mp4',
    '-segment_format_options',
    'movflags=+frag_keyframe+empty_moov+default_base_moof',
    '-segment_list',
    segmentList,
    '-segment_list_type',
    'csv',
    '-segment_start_number',
    String(published),
    join(segments, 'segment-%09d.mp4'),
  )
  const child = spawn(options.ffmpegCommand ?? 'ffmpeg', args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  })
  let stderrTail = Buffer.alloc(0)
  child.stderr?.on('data', chunk => {
    stderrTail = Buffer.concat([stderrTail, Buffer.from(chunk)]).subarray(-16 * 1024)
  })
  const abort = () => child.kill('SIGTERM')
  signal.addEventListener('abort', abort, { once: true })
  let returnCode: number | null = null
  let processError: unknown = null
  const closed = waitForChild(child)
    .then(code => {
      returnCode = code
      return code
    })
    .catch(error => {
      processError = error
      returnCode = -1
      return -1
    })
  const publishNext = async (): Promise<boolean> => {
    if (signal.aborted) return false
    const name = `segment-${String(published).padStart(9, '0')}.mp4`
    const timing = await readSegmentTiming(segmentList, name)
    if (!timing) return false
    const source = join(segments, name)
    const metadata = await stat(source).catch(() => null)
    if (!metadata?.isFile() || metadata.size <= 0) return false
    const absoluteStartUs = resume.captureTimeUs + timing.startUs
    const absoluteEndUs = resume.captureTimeUs + timing.endUs
    const targetName = recordingExtentFilename(work.segmentBaseAt, absoluteStartUs)
    const target = join(destination, targetName)
    const targetMetadata = await stat(target).catch(() => null)
    if (targetMetadata) {
      throw new MediaSourceProcessError(
        'MEDIA_EXTENT_COLLISION',
        `Recording extent ${targetName} already exists`,
      )
    }
    const checkpoint: LocalRecordingCheckpoint = {
      schemaVersion: 1,
      segmentIndex: published + 1,
      captureTimeUs: absoluteEndUs.toString(),
      targetName,
    }
    const pendingPath = join(destination, LOCAL_PENDING_CHECKPOINT_FILE)
    await writeJsonAtomic(pendingPath, checkpoint)
    await rename(source, target)
    await writeJsonAtomic(join(destination, LOCAL_CHECKPOINT_FILE), checkpoint)
    await rm(pendingPath, { force: true })
    published = checkpoint.segmentIndex
    publishedCaptureTimeUs = absoluteEndUs
    await observer.resumed(published, publishedCaptureTimeUs)
    return true
  }
  try {
    while (returnCode === null) {
      while (await publishNext()) continue
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
    }
    const code = await closed
    if (processError) throw processError
    while (await publishNext()) continue
    if (signal.aborted) throw abortError()
    if (code !== 0)
      throw new MediaSourceProcessError(
        'MEDIA_SEGMENT_FAILED',
        boundedMessage(stderrTail) || `ffmpeg exited ${code}`,
      )
    if (published === startPublished)
      throw new MediaSourceProcessError('MEDIA_EMPTY', 'Media source produced no segments')
    if (!reachedExpectedMediaEnd(publishedCaptureTimeUs, expectedDurationUs))
      throw new MediaSourceProcessError(
        'MEDIA_SOURCE_INCOMPLETE',
        `Media source stopped at ${publishedCaptureTimeUs} before ${expectedDurationUs}`,
      )
    return published
  } finally {
    signal.removeEventListener('abort', abort)
    await rm(workspace, { force: true, recursive: true }).catch(() => undefined)
  }
}

async function segmentFile(
  work: ClaimedMediaSourceWork,
  mediaPath: string,
  options: MediaSourceProcessOptions,
  observer: MediaSourceProcessObserver,
  signal: AbortSignal,
  codec: string,
  expectedDurationUs: bigint | null,
): Promise<number> {
  return segmentInputs(
    work,
    [{ url: mediaPath }],
    options,
    observer,
    signal,
    codec,
    expectedDurationUs,
  )
}

type YoutubeMetadata = {
  acodec?: string
  duration?: number | string | null
  is_live?: boolean
  live_status?: string
  requested_formats?: Array<{
    acodec?: string
    downloader_options?: { http_chunk_size?: number | string }
    http_headers?: Record<string, string>
    url?: string
    vcodec?: string
  }>
  downloader_options?: { http_chunk_size?: number | string }
  http_headers?: Record<string, string>
  url?: string
  vcodec?: string
}

function youtubeDuration(metadata: YoutubeMetadata): bigint | null {
  const seconds = Number(metadata.duration)
  return Number.isFinite(seconds) && seconds > 0 ? BigInt(Math.round(seconds * 1_000_000)) : null
}

function youtubeIsLive(metadata: YoutubeMetadata): boolean {
  return (
    metadata.is_live === true || ['is_live', 'is_upcoming'].includes(metadata.live_status ?? '')
  )
}

export function classifyYoutubeSource(metadata: {
  is_live?: boolean
  live_status?: string
}): 'youtube_live' | 'youtube_vod' {
  return youtubeIsLive(metadata) ? 'youtube_live' : 'youtube_vod'
}

function youtubeArguments(options: MediaSourceProcessOptions, extractorArgs: string): string[] {
  return [
    '--no-playlist',
    '--no-progress',
    '--no-warnings',
    '--js-runtimes',
    options.youtubeJsRuntime ?? 'deno',
    ...(options.youtubeUseCookies && options.youtubeCookiesFile
      ? ['--cookies', options.youtubeCookiesFile]
      : []),
    '--extractor-args',
    extractorArgs,
    ...(options.youtubePotProviderUrl
      ? ['--extractor-args', `youtubepot-bgutilhttp:base_url=${options.youtubePotProviderUrl}`]
      : []),
  ]
}

export function buildYoutubeProbeArgs(url: string, options: MediaSourceProcessOptions): string[] {
  return buildYoutubeProbeArgsForFormat(
    url,
    options,
    options.youtubeFormat,
    options.youtubeLiveExtractorArgs ?? options.youtubeExtractorArgs,
  )
}

export function buildYoutubeVodProbeArgs(
  url: string,
  options: MediaSourceProcessOptions,
): string[] {
  return buildYoutubeProbeArgsForFormat(
    url,
    options,
    options.youtubeVodFormat,
    options.youtubeVodExtractorArgs ?? options.youtubeExtractorArgs,
  )
}

function buildYoutubeProbeArgsForFormat(
  url: string,
  options: MediaSourceProcessOptions,
  format: string,
  extractorArgs: string,
): string[] {
  return [
    '--dump-single-json',
    ...youtubeArguments(options, extractorArgs),
    '--format',
    format,
    url,
  ]
}

async function probeYoutube(
  url: string,
  options: MediaSourceProcessOptions,
  signal: AbortSignal,
  format: 'live' | 'vod' = 'live',
): Promise<YoutubeMetadata> {
  const result = await runProcess(
    options.ytDlpCommand ?? 'yt-dlp',
    format === 'vod' ? buildYoutubeVodProbeArgs(url, options) : buildYoutubeProbeArgs(url, options),
    signal,
  )
  return JSON.parse(result.stdout.toString('utf8')) as YoutubeMetadata
}

function youtubeVideoCodec(metadata: YoutubeMetadata): string {
  return (
    metadata.requested_formats?.find(format => format.vcodec && format.vcodec !== 'none')?.vcodec ??
    metadata.vcodec ??
    ''
  ).toLowerCase()
}

function youtubeInputs(metadata: YoutubeMetadata): MediaInput[] {
  const selected = metadata.requested_formats?.length ? metadata.requested_formats : [metadata]
  return selected.map(input => {
    if (!input.url || !/^https?:\/\//.test(input.url))
      throw new MediaSourceProcessError(
        'YOUTUBE_INPUT_MISSING',
        'YouTube did not provide a playable input URL',
      )
    const chunkSize = Number(input.downloader_options?.http_chunk_size)
    return {
      ...(input.http_headers ? { httpHeaders: input.http_headers } : {}),
      ...(Number.isSafeInteger(chunkSize) && chunkSize > 0 ? { httpChunkSize: chunkSize } : {}),
      url: input.url,
    }
  })
}

export async function preflightYoutubeInput(
  input: MediaInput,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<MediaInput> {
  if (!input.httpChunkSize) return input
  const rangeStarts = [0, input.httpChunkSize]
  for (const start of rangeStarts) {
    const headers = new Headers(input.httpHeaders)
    headers.set('accept-encoding', 'identity')
    headers.set('range', `bytes=${start}-${start + YOUTUBE_PREFLIGHT_RANGE_BYTES - 1}`)
    let response: Response
    try {
      response = await request(input.url, { headers, redirect: 'follow', signal })
    } catch (error) {
      if (signal.aborted) throw error
      throw new MediaSourceProcessError(
        'BAD_SOURCE_URL',
        `YouTube media URL failed bounded range preflight at offset ${start}`,
      )
    }
    await response.body?.cancel().catch(() => undefined)
    if (response.status !== 206)
      throw new MediaSourceProcessError(
        'BAD_SOURCE_URL',
        `YouTube media URL returned HTTP ${response.status} during bounded range preflight at offset ${start}`,
      )
  }
  return input
}

export function nextLiveRelayFailureCount(
  previousFailures: number,
  previousRecordingCount: number,
  currentRecordingCount: number,
): number {
  if (
    ![previousFailures, previousRecordingCount, currentRecordingCount].every(Number.isSafeInteger)
  ) {
    throw new TypeError('live relay progress counters must be safe integers')
  }
  if (previousFailures < 0 || previousRecordingCount < 0 || currentRecordingCount < 0) {
    throw new TypeError('live relay progress counters must be non-negative')
  }
  return currentRecordingCount > previousRecordingCount ? 0 : previousFailures + 1
}

async function stableRecordingCount(root: string, signal: AbortSignal): Promise<number> {
  let previous = ''
  let stable = 0
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const files = (await readdir(root, { withFileTypes: true }).catch(() => [])).filter(
      entry => entry.isFile() && entry.name.endsWith('.mp4'),
    )
    const snapshot = (
      await Promise.all(
        files.map(async entry => {
          const metadata = await stat(join(root, entry.name))
          return `${entry.name}:${metadata.size}`
        }),
      )
    )
      .sort()
      .join('|')
    stable = snapshot && snapshot === previous ? stable + 1 : 0
    if (stable >= 3) return files.length
    previous = snapshot
    if (signal.aborted && stable >= 1) return files.length
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000))
  }
  throw new MediaSourceProcessError(
    'RECORDING_NOT_QUIESCENT',
    'Recording output did not become stable',
  )
}

export async function countMediaSourceRecordings(
  recordingRoot: string,
  ingestPath: string,
): Promise<number> {
  const directory = safeChild(recordingRoot, ingestPath)
  return (await readdir(directory, { withFileTypes: true }).catch(() => [])).filter(
    entry => entry.isFile() && entry.name.endsWith('.mp4'),
  ).length
}

export async function writeSourceRestartMarker(root: string, ingestPath: string): Promise<void> {
  const directory = safeChild(root, ingestPath)
  await mkdir(directory, { recursive: true })
  const timestamp = new Date()
    .toISOString()
    .replace('T', '_')
    .replaceAll(':', '-')
    .replace('Z', '000')
    .replace('.', '-')
  await writeFile(
    join(directory, `.source-restart-${timestamp}.marker`),
    '{"event":"source_offline"}',
    'utf8',
  )
}

export function createMediaSourceProcess(options: MediaSourceProcessOptions) {
  return async function runMediaSource(
    work: ClaimedMediaSourceWork,
    observer: MediaSourceProcessObserver,
    signal: AbortSignal,
  ): Promise<SourceCompletion> {
    if (work.sourceKind === 'local_mp4') {
      if (!work.importKey)
        throw new MediaSourceProcessError(
          'IMPORT_KEY_MISSING',
          'Local media work has no import key',
        )
      const path = safeChild(options.importRoot, work.importKey)
      const probe = await probeFile(path, options, signal)
      await observer.classified({ sourceDurationUs: probe.durationUs, sourceKind: 'local_mp4' })
      const count = await segmentFile(
        work,
        path,
        options,
        observer,
        signal,
        probe.codec,
        probe.durationUs,
      )
      return {
        expectedSegments: count,
        sourceDurationUs: probe.durationUs,
        sourceKind: 'local_mp4',
      }
    }

    if (!work.sourceUrl)
      throw new MediaSourceProcessError(
        'SOURCE_URL_MISSING',
        'YouTube media work has no source URL',
      )
    let metadata = await probeYoutube(work.sourceUrl, options, signal)
    let durationUs = youtubeDuration(metadata)
    if (classifyYoutubeSource(metadata) === 'youtube_vod') {
      // Resolve fresh progressive URLs for every attempt and segment those
      // inputs directly. Finalized fMP4 files become visible while the source
      // is still downloading; retry seeks from the persisted checkpoint.
      metadata = await probeYoutube(work.sourceUrl, options, signal, 'vod')
      durationUs ??= youtubeDuration(metadata)
      await observer.classified({ sourceDurationUs: durationUs, sourceKind: 'youtube_vod' })
      const inputs = await Promise.all(
        youtubeInputs(metadata).map(input => preflightYoutubeInput(input, signal)),
      )
      const count = await segmentInputs(
        work,
        inputs,
        options,
        observer,
        signal,
        youtubeVideoCodec(metadata),
        durationUs,
      )
      return {
        expectedSegments: count,
        sourceDurationUs: durationUs,
        sourceKind: 'youtube_vod',
      }
    }

    if (metadata.live_status === 'is_upcoming') {
      throw new MediaSourceProcessError(
        'YOUTUBE_UPCOMING',
        'YouTube live stream has not started yet',
      )
    }
    await observer.classified({ sourceDurationUs: null, sourceKind: 'youtube_live' })
    if (work.attempts > 1) await writeSourceRestartMarker(options.recordingRoot, work.ingestPath)
    const maxConsecutiveFailures = options.youtubeLiveMaxConsecutiveFailures ?? 5
    if (!Number.isSafeInteger(maxConsecutiveFailures) || maxConsecutiveFailures < 1) {
      throw new TypeError('youtubeLiveMaxConsecutiveFailures must be a positive safe integer')
    }
    let recordingCount = await countMediaSourceRecordings(options.recordingRoot, work.ingestPath)
    let consecutiveFailures = 0
    while (!signal.aborted && youtubeIsLive(metadata)) {
      const inputs = youtubeInputs(metadata)
      if (inputs.length < 1 || inputs.length > 2)
        throw new MediaSourceProcessError(
          'YOUTUBE_INPUT_COUNT',
          'YouTube returned an unsupported input layout',
        )
      const args = [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'warning',
        '-progress',
        'pipe:1',
        '-stats_period',
        '1',
      ]
      for (const input of inputs) args.push(...buildMediaInputArgs(input, true, 0))
      args.push(
        '-map',
        '0:v:0',
        '-map',
        inputs.length === 1 ? '0:a:0?' : '1:a:0',
        '-c',
        'copy',
        '-flvflags',
        'no_duration_filesize',
        '-f',
        'flv',
        `${options.ingestBaseUrl.replace(/\/+$/, '')}/${work.ingestPath}`,
      )
      try {
        await runProcess(
          options.ffmpegCommand ?? 'ffmpeg',
          args,
          signal,
          2 * 1024 * 1024,
          LIVE_RELAY_PROGRESS_TIMEOUT_MS,
        )
      } catch (error) {
        if (signal.aborted) break
        const currentRecordingCount = await countMediaSourceRecordings(
          options.recordingRoot,
          work.ingestPath,
        )
        consecutiveFailures = nextLiveRelayFailureCount(
          consecutiveFailures,
          recordingCount,
          currentRecordingCount,
        )
        recordingCount = currentRecordingCount
        const code = error instanceof MediaSourceProcessError ? error.code : 'MEDIA_COMMAND_FAILED'
        await observer.retrying?.(code)
        await writeSourceRestartMarker(options.recordingRoot, work.ingestPath)
        if (consecutiveFailures >= maxConsecutiveFailures) {
          throw new MediaSourceProcessError(
            'YOUTUBE_LIVE_RELAY_STALLED',
            `YouTube live relay made no recording progress after ${consecutiveFailures} consecutive failures`,
          )
        }
        await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000))
      }
      if (!signal.aborted) metadata = await probeYoutube(work.sourceUrl, options, signal)
    }
    const directory = safeChild(options.recordingRoot, work.ingestPath)
    const count = await stableRecordingCount(directory, signal)
    return { expectedSegments: count, sourceDurationUs: null, sourceKind: 'youtube_live' }
  }
}
