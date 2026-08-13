import { spawn, type ChildProcess } from 'node:child_process'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { ClaimedMediaSourceWork, SourceCompletion } from './source-work.js'

type ProcessResult = { stderr: Buffer; stdout: Buffer }

export type MediaSourceProcessOptions = {
  importRoot: string
  ingestBaseUrl: string
  recordingRoot: string
  workRoot: string
  youtubeCookiesFile?: string
  youtubeExtractorArgs: string
  youtubeFormat: string
  youtubeVodConcurrentFragments: number
  youtubeVodFormat: string
  ytDlpCommand?: string
  ffmpegCommand?: string
  ffprobeCommand?: string
}

type MediaInput = {
  httpHeaders?: Record<string, string>
  url: string
}

export type MediaSourceProcessObserver = {
  classified(value: Pick<SourceCompletion, 'sourceDurationUs' | 'sourceKind'>): Promise<void>
  resumed(segmentIndex: number, captureTimeUs: bigint): Promise<void>
}

export class MediaSourceProcessError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'MediaSourceProcessError'
  }
}

function abortError(): Error {
  return new DOMException('The media source was stopped', 'AbortError')
}

function boundedMessage(value: Buffer): string {
  return value.subarray(Math.max(0, value.length - 1_024)).toString('utf8').replace(/[\r\n]+/g, ' ').trim()
}

async function runProcess(
  command: string,
  args: string[],
  signal: AbortSignal,
  maxOutputBytes = 16 * 1024 * 1024,
): Promise<ProcessResult> {
  if (signal.aborted) throw abortError()
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let outputBytes = 0
  const collect = (target: Buffer[], chunk: Buffer) => {
    outputBytes += chunk.length
    if (outputBytes > maxOutputBytes) child.kill('SIGKILL')
    else target.push(chunk)
  }
  child.stdout?.on('data', chunk => collect(stdout, Buffer.from(chunk)))
  child.stderr?.on('data', chunk => collect(stderr, Buffer.from(chunk)))
  const abort = () => child.kill('SIGTERM')
  signal.addEventListener('abort', abort, { once: true })
  try {
    const code = await new Promise<number>((resolvePromise, reject) => {
      child.once('error', reject)
      child.once('close', value => resolvePromise(value ?? -1))
    })
    if (signal.aborted) throw abortError()
    const result = { stderr: Buffer.concat(stderr), stdout: Buffer.concat(stdout) }
    if (outputBytes > maxOutputBytes) throw new MediaSourceProcessError('PROCESS_OUTPUT_LIMIT', 'Media command produced too much output')
    if (code !== 0) throw new MediaSourceProcessError('MEDIA_COMMAND_FAILED', boundedMessage(result.stderr) || `Media command exited ${code}`)
    return result
  }
  finally { signal.removeEventListener('abort', abort) }
}

function safeChild(rootValue: string, childValue: string): string {
  const root = resolve(rootValue)
  const target = isAbsolute(childValue) ? resolve(childValue) : resolve(root, childValue)
  const relation = relative(root, target)
  if (!relation || relation.startsWith('..') || isAbsolute(relation)) throw new MediaSourceProcessError('INVALID_MEDIA_PATH', 'Media path escapes its configured root')
  return target
}

function timestampName(base: Date, index: number): string {
  const value = new Date(base.getTime() + index * 2_000)
  const date = value.toISOString().slice(0, 19).replace('T', '_').replaceAll(':', '-')
  return `${date}-${String(value.getUTCMilliseconds() * 1_000).padStart(6, '0')}.mp4`
}

async function existingPrefix(destination: string, base: Date): Promise<number> {
  let index = 0
  while (true) {
    try {
      const metadata = await stat(join(destination, timestampName(base, index)))
      if (!metadata.isFile() || metadata.size <= 0) return index
      index += 1
    }
    catch { return index }
  }
}

function segmentListEndTimeUs(content: string, segmentName: string): bigint | null {
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue
    const fields = line.split(',')
    if (fields.length < 3) continue
    const end = Number(fields.pop())
    fields.pop()
    const rawPath = fields.join(',').trim().replace(/^"|"$/g, '').replaceAll('\\', '/')
    if (!rawPath.endsWith(`/${segmentName}`) && rawPath !== segmentName) continue
    if (!Number.isFinite(end) || end <= 0) return null
    return BigInt(Math.round(end * 1_000_000))
  }
  return null
}

async function segmentEndTimeUs(listPath: string, segmentName: string): Promise<bigint | null> {
  const content = await readFile(listPath, 'utf8').catch(() => '')
  return segmentListEndTimeUs(content, segmentName)
}

async function probeFile(
  path: string,
  options: MediaSourceProcessOptions,
  signal: AbortSignal,
): Promise<{ codec: string; durationUs: bigint | null }> {
  const result = await runProcess(options.ffprobeCommand ?? 'ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name:format=duration', '-of', 'json', path,
  ], signal)
  const value = JSON.parse(result.stdout.toString('utf8')) as {
    format?: { duration?: string }
    streams?: Array<{ codec_name?: string }>
  }
  const seconds = Number(value.format?.duration)
  return {
    codec: value.streams?.[0]?.codec_name?.toLowerCase() ?? '',
    durationUs: Number.isFinite(seconds) && seconds > 0 ? BigInt(Math.round(seconds * 1_000_000)) : null,
  }
}

async function waitForChild(child: ChildProcess): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('close', code => resolvePromise(code ?? -1))
  })
}

function mediaInputArgs(input: MediaInput, realtime: boolean, seekSeconds: number): string[] {
  const headers = Object.entries(input.httpHeaders ?? {}).map(([name, value]) => `${name}: ${value}\r\n`).join('')
  return [
    ...(seekSeconds > 0 ? ['-ss', seekSeconds.toFixed(6)] : []),
    ...(headers ? ['-headers', headers] : []),
    ...(realtime ? ['-re'] : []),
    '-i', input.url,
  ]
}

async function segmentInputs(
  work: ClaimedMediaSourceWork,
  inputs: readonly MediaInput[],
  options: MediaSourceProcessOptions,
  observer: MediaSourceProcessObserver,
  signal: AbortSignal,
  codec: string,
  realtime = false,
): Promise<number> {
  if (inputs.length < 1 || inputs.length > 2) throw new MediaSourceProcessError('YOUTUBE_INPUT_COUNT', 'Media source returned an unsupported input layout')
  const destination = safeChild(options.recordingRoot, work.ingestPath)
  const workspace = safeChild(options.workRoot, work.id)
  const segments = join(workspace, 'segments')
  const segmentList = join(workspace, 'segments.csv')
  await mkdir(destination, { recursive: true })
  await rm(workspace, { force: true, recursive: true })
  await mkdir(segments, { recursive: true })
  let published = Math.max(work.resumeSegmentIndex, await existingPrefix(destination, work.segmentBaseAt))
  const startPublished = published
  const seekSeconds = Number(work.resumeCaptureTimeUs) / 1_000_000
  const videoCodec = codec === 'h264' || codec.startsWith('avc')
    ? ['-c:v', 'copy']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p']
  const args = [
    '-nostdin', '-hide_banner', '-loglevel', 'warning',
  ]
  for (const input of inputs) args.push(...mediaInputArgs(input, realtime, seekSeconds))
  args.push(
    '-map', '0:v:0', '-map', inputs.length === 1 ? '0:a:0?' : '1:a:0',
    ...videoCodec, '-c:a', 'aac', '-f', 'segment', '-segment_time', '2',
    '-reset_timestamps', '1', '-segment_format', 'mp4',
    '-segment_format_options', 'movflags=+frag_keyframe+empty_moov+default_base_moof',
    '-segment_list', segmentList, '-segment_list_type', 'csv',
    '-segment_start_number', String(published), join(segments, 'segment-%09d.mp4'),
  )
  const child = spawn(options.ffmpegCommand ?? 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  const stderr: Buffer[] = []
  child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)))
  const abort = () => child.kill('SIGTERM')
  signal.addEventListener('abort', abort, { once: true })
  let returnCode: number | null = null
  let processError: unknown = null
  const closed = waitForChild(child)
    .then(code => { returnCode = code; return code })
    .catch((error) => { processError = error; returnCode = -1; return -1 })
  try {
    while (returnCode === null) {
      const files = (await readdir(segments)).filter(name => /^segment-\d{9}\.mp4$/.test(name)).sort()
      const publishable = files.slice(0, Math.max(0, files.length - 1))
      for (const name of publishable) {
        const index = Number(name.slice(8, 17))
        if (index !== published) continue
        const relativeEndUs = await segmentEndTimeUs(segmentList, name)
        if (relativeEndUs === null) continue
        const target = join(destination, timestampName(work.segmentBaseAt, index))
        const temporary = `${target}.part`
        await copyFile(join(segments, name), temporary)
        await rename(temporary, target)
        published += 1
        await observer.resumed(published, work.resumeCaptureTimeUs + relativeEndUs)
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
    }
    const code = await closed
    if (processError) throw processError
    const files = (await readdir(segments)).filter(name => /^segment-\d{9}\.mp4$/.test(name)).sort()
    const publishable = signal.aborted ? files.slice(0, Math.max(0, files.length - 1)) : files
    for (const name of publishable) {
      const index = Number(name.slice(8, 17))
      if (index !== published) continue
      const relativeEndUs = await segmentEndTimeUs(segmentList, name)
      if (relativeEndUs === null) throw new MediaSourceProcessError('MEDIA_SEGMENT_TIMING_MISSING', `Missing timing for ${name}`)
      const target = join(destination, timestampName(work.segmentBaseAt, index))
      const temporary = `${target}.part`
      await copyFile(join(segments, name), temporary)
      await rename(temporary, target)
      published += 1
      await observer.resumed(published, work.resumeCaptureTimeUs + relativeEndUs)
    }
    if (signal.aborted) throw abortError()
    if (code !== 0) throw new MediaSourceProcessError('MEDIA_SEGMENT_FAILED', boundedMessage(Buffer.concat(stderr)) || `ffmpeg exited ${code}`)
    if (published === startPublished) throw new MediaSourceProcessError('MEDIA_EMPTY', 'Media source produced no segments')
    return published
  }
  finally {
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
): Promise<number> {
  return segmentInputs(work, [{ url: mediaPath }], options, observer, signal, codec)
}

type YoutubeMetadata = {
  acodec?: string
  duration?: number | string | null
  is_live?: boolean
  live_status?: string
  requested_formats?: Array<{ acodec?: string; http_headers?: Record<string, string>; url?: string; vcodec?: string }>
  http_headers?: Record<string, string>
  url?: string
  vcodec?: string
}

function youtubeDuration(metadata: YoutubeMetadata): bigint | null {
  const seconds = Number(metadata.duration)
  return Number.isFinite(seconds) && seconds > 0 ? BigInt(Math.round(seconds * 1_000_000)) : null
}

function youtubeIsLive(metadata: YoutubeMetadata): boolean {
  return metadata.is_live === true || ['is_live', 'is_upcoming'].includes(metadata.live_status ?? '')
}

export function classifyYoutubeSource(metadata: { is_live?: boolean; live_status?: string }): 'youtube_live' | 'youtube_vod' {
  return youtubeIsLive(metadata) ? 'youtube_live' : 'youtube_vod'
}

function youtubeArguments(options: MediaSourceProcessOptions): string[] {
  return [
    '--no-playlist', '--no-progress', '--no-warnings',
    ...(options.youtubeCookiesFile ? ['--cookies', options.youtubeCookiesFile] : []),
    '--extractor-args', options.youtubeExtractorArgs,
  ]
}

export function buildYoutubeProbeArgs(url: string, options: MediaSourceProcessOptions): string[] {
  return [
    '--dump-single-json',
    ...youtubeArguments(options),
    '--format', options.youtubeFormat,
    url,
  ]
}

export function buildYoutubeVodDownloadArgs(
  url: string,
  output: string,
  options: MediaSourceProcessOptions,
): string[] {
  return [
    ...youtubeArguments(options),
    '--abort-on-unavailable-fragments',
    '--concurrent-fragments', String(options.youtubeVodConcurrentFragments),
    '--format', options.youtubeVodFormat,
    '--merge-output-format', 'mp4',
    '--output', output,
    url,
  ]
}

async function probeYoutube(
  url: string,
  options: MediaSourceProcessOptions,
  signal: AbortSignal,
): Promise<YoutubeMetadata> {
  const result = await runProcess(options.ytDlpCommand ?? 'yt-dlp', buildYoutubeProbeArgs(url, options), signal)
  return JSON.parse(result.stdout.toString('utf8')) as YoutubeMetadata
}

function youtubeInputs(metadata: YoutubeMetadata): MediaInput[] {
  const selected = metadata.requested_formats?.length ? metadata.requested_formats : [metadata]
  return selected.map((input) => {
    if (!input.url || !/^https?:\/\//.test(input.url)) throw new MediaSourceProcessError('YOUTUBE_INPUT_MISSING', 'YouTube did not provide a playable input URL')
    return input.http_headers ? { httpHeaders: input.http_headers, url: input.url } : { url: input.url }
  })
}

function youtubeVideoCodec(metadata: YoutubeMetadata): string {
  return metadata.vcodec ?? metadata.requested_formats?.find(format => format.vcodec && format.vcodec !== 'none')?.vcodec ?? ''
}

async function stableRecordingCount(root: string, signal: AbortSignal): Promise<number> {
  let previous = ''
  let stable = 0
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const files = (await readdir(root, { withFileTypes: true }).catch(() => []))
      .filter(entry => entry.isFile() && entry.name.endsWith('.mp4'))
    const snapshot = (await Promise.all(files.map(async entry => {
      const metadata = await stat(join(root, entry.name))
      return `${entry.name}:${metadata.size}`
    }))).sort().join('|')
    stable = snapshot && snapshot === previous ? stable + 1 : 0
    if (stable >= 3) return files.length
    previous = snapshot
    if (signal.aborted && stable >= 1) return files.length
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000))
  }
  throw new MediaSourceProcessError('RECORDING_NOT_QUIESCENT', 'Recording output did not become stable')
}

export async function countMediaSourceRecordings(
  recordingRoot: string,
  ingestPath: string,
): Promise<number> {
  const directory = safeChild(recordingRoot, ingestPath)
  return (await readdir(directory, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isFile() && entry.name.endsWith('.mp4')).length
}

export async function writeSourceRestartMarker(root: string, ingestPath: string): Promise<void> {
  const directory = safeChild(root, ingestPath)
  await mkdir(directory, { recursive: true })
  const timestamp = new Date().toISOString().replace('T', '_').replaceAll(':', '-').replace('Z', '000').replace('.', '-')
  await writeFile(join(directory, `.source-restart-${timestamp}.marker`), '{"event":"source_offline"}', 'utf8')
}

export function createMediaSourceProcess(options: MediaSourceProcessOptions) {
  return async function runMediaSource(
    work: ClaimedMediaSourceWork,
    observer: MediaSourceProcessObserver,
    signal: AbortSignal,
  ): Promise<SourceCompletion> {
    if (work.sourceKind === 'local_mp4') {
      if (!work.importKey) throw new MediaSourceProcessError('IMPORT_KEY_MISSING', 'Local media work has no import key')
      const path = safeChild(options.importRoot, work.importKey)
      const probe = await probeFile(path, options, signal)
      await observer.classified({ sourceDurationUs: probe.durationUs, sourceKind: 'local_mp4' })
      const count = await segmentFile(work, path, options, observer, signal, probe.codec)
      return { expectedSegments: count, sourceDurationUs: probe.durationUs, sourceKind: 'local_mp4' }
    }

    if (!work.sourceUrl) throw new MediaSourceProcessError('SOURCE_URL_MISSING', 'YouTube media work has no source URL')
    let metadata = await probeYoutube(work.sourceUrl, options, signal)
    const durationUs = youtubeDuration(metadata)
    if (classifyYoutubeSource(metadata) === 'youtube_vod') {
      await observer.classified({ sourceDurationUs: durationUs, sourceKind: 'youtube_vod' })
      const workspace = safeChild(options.workRoot, `${work.id}-download`)
      await rm(workspace, { force: true, recursive: true })
      await mkdir(workspace, { recursive: true })
      try {
        await runProcess(
          options.ytDlpCommand ?? 'yt-dlp',
          buildYoutubeVodDownloadArgs(work.sourceUrl, join(workspace, 'source.%(ext)s'), options),
          signal,
          2 * 1024 * 1024,
        )
        const downloaded = (await readdir(workspace)).find(name => name.startsWith('source.') && name.endsWith('.mp4'))
        if (!downloaded) throw new MediaSourceProcessError('YOUTUBE_DOWNLOAD_MISSING', 'YouTube download did not produce an MP4')
        const path = join(workspace, downloaded)
        const probe = await probeFile(path, options, signal)
        const count = await segmentFile(work, path, options, observer, signal, probe.codec)
        return { expectedSegments: count, sourceDurationUs: durationUs ?? probe.durationUs, sourceKind: 'youtube_vod' }
      }
      finally { await rm(workspace, { force: true, recursive: true }).catch(() => undefined) }
    }

    if (metadata.live_status === 'is_upcoming') {
      throw new MediaSourceProcessError('YOUTUBE_UPCOMING', 'YouTube live stream has not started yet')
    }
    await observer.classified({ sourceDurationUs: null, sourceKind: 'youtube_live' })
    if (work.attempts > 1) await writeSourceRestartMarker(options.recordingRoot, work.ingestPath)
    while (!signal.aborted && youtubeIsLive(metadata)) {
      const inputs = youtubeInputs(metadata)
      if (inputs.length < 1 || inputs.length > 2) throw new MediaSourceProcessError('YOUTUBE_INPUT_COUNT', 'YouTube returned an unsupported input layout')
      const args = ['-nostdin', '-hide_banner', '-loglevel', 'warning']
      for (const input of inputs) args.push(...mediaInputArgs(input, true, 0))
      args.push('-map', '0:v:0', '-map', inputs.length === 1 ? '0:a:0?' : '1:a:0', '-c', 'copy', '-flvflags', 'no_duration_filesize', '-f', 'flv', `${options.ingestBaseUrl.replace(/\/+$/, '')}/${work.ingestPath}`)
      try { await runProcess(options.ffmpegCommand ?? 'ffmpeg', args, signal, 2 * 1024 * 1024) }
      catch (error) {
        if (signal.aborted) break
        await writeSourceRestartMarker(options.recordingRoot, work.ingestPath)
        await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000))
      }
      if (!signal.aborted) metadata = await probeYoutube(work.sourceUrl, options, signal)
    }
    const directory = safeChild(options.recordingRoot, work.ingestPath)
    const count = await stableRecordingCount(directory, signal)
    return { expectedSegments: count, sourceDurationUs: null, sourceKind: 'youtube_live' }
  }
}
