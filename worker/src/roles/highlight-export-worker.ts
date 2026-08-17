import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismaClient } from '@volleyball-monitoring/db'
import { ArtifactState, JobStatus, MediaAssetKind, Prisma } from '@volleyball-monitoring/db/client'
import { z } from 'zod'
import { appendVerifiedObject, createWorkflowMinio, uploadFile } from '../workflow/minio.js'
import { createPollingLifecycle, type PollingLifecycle } from '../workflow/poller.js'

const LEASE_MS = 20 * 60_000
const RETRY_BASE_MS = 5_000
const decimal = z.string().regex(/^\d+$/)
const payloadSchema = z.object({
  schema_version: z.literal('1.0.0'),
  subject_label: z.string().min(1),
  filter_label: z.string().min(1),
  events: z.array(
    z.object({
      event_id: z.string(),
      rally_id: z.string().uuid(),
      clip_job_id: z.string().uuid(),
      clip_duration_us: decimal,
      anchor_time_us: decimal,
      set_number: z.number().int().positive(),
      rally_ordinal: z.number().int().positive(),
      action_key: z.string(),
      action_label: z.string().min(1),
      source_asset: z.object({
        id: z.string().uuid(),
        bucket: z.string().min(1),
        object_key: z.string().min(1),
        content_type: z.string().min(1),
        byte_length: decimal.nullable(),
        sha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
      }),
    }),
  ),
})

type HighlightPayload = z.infer<typeof payloadSchema>

function runProcess(
  executable: string,
  args: string[],
  signal: AbortSignal,
  timeoutMs = 15 * 60_000,
) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(executable, args, { shell: false })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      if (error) reject(error)
      else
        resolve({
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
        })
    }
    const abort = () => {
      child.kill()
      finish(new Error(`${executable} cancelled`))
    }
    const timeout = setTimeout(() => {
      child.kill()
      finish(new Error(`${executable} timed out`))
    }, timeoutMs)
    child.stdout.on('data', value => stdout.push(Buffer.from(value)))
    child.stderr.on('data', value => stderr.push(Buffer.from(value)))
    child.on('error', error => finish(error))
    child.on('close', code =>
      code === 0
        ? finish()
        : finish(
            new Error(
              `${executable} failed (${code}): ${Buffer.concat(stderr).toString().slice(-1200)}`,
            ),
          ),
    )
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

function ffmpegPath(value: string) {
  return value.replaceAll('\\', '/').replaceAll(':', '\\:').replaceAll("'", "\\'")
}

function fontFile() {
  if (process.env.HIGHLIGHT_FONT_FILE) return process.env.HIGHLIGHT_FONT_FILE
  const candidates =
    process.platform === 'win32'
      ? ['C:/Windows/Fonts/msjh.ttc', 'C:/Windows/Fonts/msjhbd.ttc']
      : [
          '/usr/share/fonts/noto/NotoSansCJK-Regular.ttc',
          '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
          '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
        ]
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0]!
}

export function highlightWindow(anchorTimeUs: string, durationUs: string) {
  const duration = BigInt(durationUs)
  const anchor = BigInt(anchorTimeUs)
  const start = anchor > 3_000_000n ? anchor - 3_000_000n : 0n
  const end = anchor + 2_000_000n < duration ? anchor + 2_000_000n : duration
  return { startUs: start, durationUs: end > start ? end - start : 0n }
}

export function buildHighlightVideoFilter(input: {
  subjectFile: string
  detailFile: string
  fontFile: string
}) {
  const font = ffmpegPath(input.fontFile)
  const subject = ffmpegPath(input.subjectFile)
  const detail = ffmpegPath(input.detailFile)
  return [
    'scale=1280:720:force_original_aspect_ratio=decrease',
    'pad=1280:720:(ow-iw)/2:(oh-ih)/2:black',
    'setsar=1',
    'drawbox=x=0:y=ih-106:w=iw:h=106:color=black@0.58:t=fill',
    `drawtext=fontfile='${font}':textfile='${subject}':expansion=none:fontcolor=white:fontsize=26:x=34:y=main_h-88`,
    `drawtext=fontfile='${font}':textfile='${detail}':expansion=none:fontcolor=white@0.82:fontsize=18:x=34:y=main_h-48`,
  ].join(',')
}

function microsecondsAsSeconds(value: bigint) {
  return `${value / 1_000_000n}.${String(value % 1_000_000n).padStart(6, '0')}`
}

async function hasAudio(file: string, signal: AbortSignal) {
  const result = await runProcess(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=index',
      '-of',
      'csv=p=0',
      file,
    ],
    signal,
    60_000,
  )
  return result.stdout.trim().length > 0
}

async function claimJob(database: PrismaClient) {
  return database.$transaction(async tx => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "CoachHighlightExportJob"
      WHERE ((status = 'QUEUED' AND "availableAt" <= NOW()) OR (status = 'RUNNING' AND "leasedUntil" < NOW()))
        AND "attemptCount" < "maxAttempts"
      ORDER BY "availableAt", "createdAt", id
      FOR UPDATE SKIP LOCKED LIMIT 1
    `
    if (!rows[0]) return null
    return tx.coachHighlightExportJob.update({
      where: { id: rows[0].id },
      data: {
        status: JobStatus.RUNNING,
        progress: 2,
        attemptCount: { increment: 1 },
        leasedUntil: new Date(Date.now() + LEASE_MS),
        startedAt: new Date(),
        errorCode: null,
        errorMessage: null,
      },
    })
  })
}

async function retryOrFail(database: PrismaClient, jobId: string, error: unknown) {
  const current = await database.coachHighlightExportJob.findUnique({
    where: { id: jobId },
    select: { attemptCount: true, maxAttempts: true },
  })
  if (!current) return
  const terminal = current.attemptCount >= current.maxAttempts
  await database.coachHighlightExportJob.update({
    where: { id: jobId },
    data: {
      status: terminal ? JobStatus.FAILED : JobStatus.QUEUED,
      progress: 0,
      leasedUntil: null,
      availableAt: new Date(Date.now() + RETRY_BASE_MS * 2 ** current.attemptCount),
      errorCode: 'HIGHLIGHT_EXPORT_FAILED',
      errorMessage:
        error instanceof Error ? error.message.slice(0, 500) : 'highlight export failed',
    },
  })
}

async function renderHighlight(
  database: PrismaClient,
  job: { id: string; matchId: string; requestPayload: Prisma.JsonValue },
  signal: AbortSignal,
) {
  const payload = payloadSchema.parse(job.requestPayload) as HighlightPayload
  const directory = await mkdtemp(join(tmpdir(), 'volleyball-highlight-'))
  const storage = createWorkflowMinio()
  try {
    const rendered: string[] = []
    for (const [index, event] of payload.events.entries()) {
      const source = join(directory, `source-${index}.mp4`)
      const output = join(directory, `segment-${index}.mp4`)
      const subjectFile = join(directory, `subject-${index}.txt`)
      const detailFile = join(directory, `detail-${index}.txt`)
      await Promise.all([
        appendVerifiedObject(
          storage.client,
          {
            bucket: event.source_asset.bucket,
            objectKey: event.source_asset.object_key,
            byteLength:
              event.source_asset.byte_length === null
                ? null
                : BigInt(event.source_asset.byte_length),
            sha256: event.source_asset.sha256,
          },
          source,
        ),
        writeFile(subjectFile, payload.subject_label, 'utf8'),
        writeFile(
          detailFile,
          `第 ${event.set_number} 局 · 回合 ${event.rally_ordinal} · ${event.action_label}`,
          'utf8',
        ),
      ])
      const window = highlightWindow(event.anchor_time_us, event.clip_duration_us)
      if (window.durationUs <= 0n)
        throw new Error(`event ${event.event_id} has an empty replay window`)
      const audio = await hasAudio(source, signal)
      const args = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-ss',
        microsecondsAsSeconds(window.startUs),
        '-t',
        microsecondsAsSeconds(window.durationUs),
        '-i',
        source,
      ]
      if (!audio)
        args.push(
          '-f',
          'lavfi',
          '-t',
          microsecondsAsSeconds(window.durationUs),
          '-i',
          'anullsrc=channel_layout=stereo:sample_rate=48000',
        )
      args.push(
        '-map',
        '0:v:0',
        '-map',
        audio ? '0:a:0' : '1:a:0',
        '-vf',
        buildHighlightVideoFilter({ subjectFile, detailFile, fontFile: fontFile() }),
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '22',
        '-pix_fmt',
        'yuv420p',
        '-r',
        '30',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-shortest',
        '-movflags',
        '+faststart',
        output,
      )
      await runProcess('ffmpeg', args, signal)
      rendered.push(output)
      await database.coachHighlightExportJob.update({
        where: { id: job.id },
        data: { progress: 5 + Math.floor(((index + 1) / payload.events.length) * 85) },
      })
    }

    const concatList = join(directory, 'concat.txt')
    await writeFile(
      concatList,
      rendered
        .map(file => `file '${file.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`)
        .join('\n'),
      'utf8',
    )
    const output = join(directory, 'highlight.mp4')
    await database.coachHighlightExportJob.update({ where: { id: job.id }, data: { progress: 94 } })
    await runProcess(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        concatList,
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        output,
      ],
      signal,
    )
    const objectKey = `highlights/${job.matchId}/${job.id}.mp4`
    const uploaded = await uploadFile(
      storage.client,
      storage.rallyBucket,
      objectKey,
      output,
      'video/mp4',
    )
    await database.$transaction(async tx => {
      const asset = await tx.mediaAsset.create({
        data: {
          kind: MediaAssetKind.HIGHLIGHT_REEL,
          bucket: storage.rallyBucket,
          objectKey,
          contentType: 'video/mp4',
          byteLength: uploaded.byteLength,
          sha256: uploaded.sha256,
          state: ArtifactState.READY,
          readyAt: new Date(),
        },
      })
      await tx.coachHighlightExportJob.update({
        where: { id: job.id },
        data: {
          status: JobStatus.COMPLETED,
          progress: 100,
          outputAssetId: asset.id,
          leasedUntil: null,
          completedAt: new Date(),
        },
      })
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export function createHighlightExportWorker(
  database: PrismaClient,
  options: { idleMs?: number; disconnectOnStop?: boolean; onError?: (error: unknown) => void } = {},
): PollingLifecycle {
  return createPollingLifecycle(
    async signal => {
      const job = await claimJob(database)
      if (!job) return false
      try {
        await renderHighlight(database, job, signal)
      } catch (error) {
        await retryOrFail(database, job.id, error)
        options.onError?.(error)
      }
      return true
    },
    {
      idleMs: options.idleMs ?? 750,
      ...(options.onError ? { onError: options.onError } : {}),
      ...(options.disconnectOnStop === false ? {} : { disconnect: () => database.$disconnect() }),
    },
  )
}
