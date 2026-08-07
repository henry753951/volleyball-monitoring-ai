import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismaClient } from '@volleyball-monitoring/db'
import { JobStatus, MediaAssetKind, ProcessingStatus } from '@volleyball-monitoring/db/client'
import { createNodeProbeRunner } from '../media/ffprobe.js'
import { callbackToken, sha256Hex, stableJson } from '../workflow/crypto.js'
import { appendVerifiedObject, createWorkflowMinio, uploadFile } from '../workflow/minio.js'
import { createPollingLifecycle } from '../workflow/poller.js'

const runner = createNodeProbeRunner()
const leaseMs = 5 * 60_000

function roundRatio(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new Error('invalid clip timing ratio')
  return (numerator * 2n + denominator) / (denominator * 2n)
}

function safeSeconds(valueUs: bigint): string {
  if (valueUs < 0n || valueUs > 3_600_000_000n) throw new Error('clip duration is outside the bounded profile')
  return `${valueUs / 1_000_000n}.${(valueUs % 1_000_000n).toString().padStart(6, '0')}`
}

async function runCommand(executable: string, args: string[], signal: AbortSignal) {
  const result = await runner(executable, args, { shell: false, timeoutMs: 10 * 60_000, maxOutputBytes: 4_000_000, signal })
  if (result.code !== 0) throw new Error(`${executable} failed: ${result.stderr.slice(-1_000)}`)
  return result.stdout
}

type Probe = { streams?: Array<{ codec_type?: string; width?: number; height?: number; avg_frame_rate?: string; time_base?: string; nb_read_frames?: string; duration?: string }>; format?: { duration?: string } }
function rational(value: string | undefined, fallback: { num: number; den: number }): { num: number; den: number } {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? '')
  if (!match) return fallback
  const num = Number(match[1])
  const den = Number(match[2])
  return Number.isInteger(num) && num > 0 && Number.isInteger(den) && den > 0 ? { num, den } : fallback
}

async function probeCanonicalClip(filePath: string, fallback: { fpsNum: number; fpsDen: number }, signal: AbortSignal) {
  const output = await runCommand('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,width,height,avg_frame_rate,time_base,nb_read_frames,duration:format=duration', '-of', 'json', filePath], signal)
  const payload = JSON.parse(output) as Probe
  const video = payload.streams?.find(stream => stream.codec_type === 'video')
  if (!video?.width || !video.height) throw new Error('canonical clip has no valid video stream')
  const fps = rational(video.avg_frame_rate, { num: fallback.fpsNum, den: fallback.fpsDen })
  const timeBase = rational(video.time_base, { num: 1, den: 90_000 })
  const durationSeconds = Number(video.duration ?? payload.format?.duration)
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('canonical clip duration is invalid')
  const durationUs = BigInt(Math.round(durationSeconds * 1_000_000))
  const totalFrames = video.nb_read_frames && /^\d+$/.test(video.nb_read_frames)
    ? BigInt(video.nb_read_frames)
    : roundRatio(durationUs * BigInt(fps.num), 1_000_000n * BigInt(fps.den))
  if (totalFrames <= 0n) throw new Error('canonical clip frame count is invalid')
  return { width: video.width, height: video.height, fps, timeBase, totalFrames, durationUs, hasAudio: payload.streams?.some(stream => stream.codec_type === 'audio') ?? false }
}

async function claimClipJob(database: PrismaClient) {
  return database.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "ClipJob"
      WHERE ((status = 'QUEUED' AND "availableAt" <= NOW()) OR (status = 'RUNNING' AND "leasedUntil" < NOW()))
        AND "attemptCount" < "maxAttempts"
      ORDER BY "availableAt", "createdAt", id
      FOR UPDATE SKIP LOCKED LIMIT 1
    `
    const id = rows[0]?.id
    if (!id) return null
    return tx.clipJob.update({ where: { id }, data: { status: JobStatus.RUNNING, attemptCount: { increment: 1 }, leasedUntil: new Date(Date.now() + leaseMs), startedAt: new Date(), errorCode: null, errorMessage: null } })
  })
}

async function failClipJob(database: PrismaClient, jobId: string, error: unknown) {
  const current = await database.clipJob.findUnique({ where: { id: jobId }, select: { attemptCount: true, maxAttempts: true, submission: { select: { rallyId: true } } } })
  if (!current) return
  const terminal = current.attemptCount >= current.maxAttempts
  await database.$transaction([
    database.clipJob.update({ where: { id: jobId }, data: { status: terminal ? JobStatus.FAILED : JobStatus.QUEUED, leasedUntil: null, availableAt: new Date(Date.now() + Math.min(60_000, 1_000 * 2 ** current.attemptCount)), errorCode: 'CLIP_GENERATION_FAILED', errorMessage: error instanceof Error ? error.message.slice(0, 500) : 'clip generation failed' } }),
    database.rally.update({ where: { id: current.submission.rallyId }, data: { processingStatus: terminal ? ProcessingStatus.FAILED : ProcessingStatus.CLIP_QUEUED } }),
  ])
}

export function createClipWorker(database: PrismaClient) {
  const storage = createWorkflowMinio()
  const callbackSecret = process.env.AI_CALLBACK_TOKEN_SECRET ?? ''

  async function processNext(signal: AbortSignal): Promise<boolean> {
    const claimed = await claimClipJob(database)
    if (!claimed) return false
    const directory = await mkdtemp(join(tmpdir(), 'volleyball-clip-'))
    try {
      const job = await database.clipJob.findUniqueOrThrow({
        where: { id: claimed.id },
        include: { submission: { include: { rally: { include: { program: true } }, keyPoints: { orderBy: { sequenceIndex: 'asc' } } } } },
      })
      const program = job.submission.rally.program
      const candidates = await database.dvrSegment.findMany({
        where: { dvrProgramId: program.id, isGap: false, readyAt: { not: null }, captureStartUs: { lt: job.requestedEndCaptureUs }, captureEndUs: { gt: job.requestedStartCaptureUs } },
        orderBy: { sequenceNumber: 'asc' },
        include: { initAsset: true, mediaAsset: true },
      })
      const firstPoint = job.submission.keyPoints[0]
      const anchorSegment = firstPoint ? candidates.find(segment => firstPoint.captureTimeUs >= segment.captureStartUs && firstPoint.captureTimeUs < segment.captureEndUs) : null
      const segments = anchorSegment ? candidates.filter(segment => segment.discontinuitySequence === anchorSegment.discontinuitySequence) : []
      if (!segments.length || !segments[0]?.initAsset || segments.some(segment => !segment.mediaAsset)) throw new Error('requested DVR range is not ready')
      for (let index = 1; index < segments.length; index += 1) {
        if (segments[index]!.discontinuitySequence !== segments[0]!.discontinuitySequence || segments[index]!.captureStartUs > segments[index - 1]!.captureEndUs) throw new Error('canonical clip cannot cross a gap or discontinuity')
      }
      const actualStart = job.requestedStartCaptureUs > segments[0]!.captureStartUs ? job.requestedStartCaptureUs : segments[0]!.captureStartUs
      const last = segments.at(-1)!
      const actualEnd = job.requestedEndCaptureUs < last.captureEndUs ? job.requestedEndCaptureUs : last.captureEndUs
      if (actualEnd <= actualStart || job.submission.keyPoints.some(point => point.captureTimeUs < actualStart || point.captureTimeUs >= actualEnd)) throw new Error('immutable key point lies outside the ready clip range')

      const sourcePath = join(directory, 'source.mp4')
      await appendVerifiedObject(storage.client, segments[0]!.initAsset!, sourcePath)
      for (const segment of segments) await appendVerifiedObject(storage.client, segment.mediaAsset!, sourcePath)
      const outputPath = join(directory, 'canonical.mp4')
      await runCommand('ffmpeg', ['-y', '-v', 'error', '-ss', safeSeconds(actualStart - segments[0]!.captureStartUs), '-i', sourcePath, '-t', safeSeconds(actualEnd - actualStart), '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-r', `${program.fpsNum}/${program.fpsDen}`, '-c:a', 'aac', '-movflags', '+faststart', outputPath], signal)
      const video = await probeCanonicalClip(outputPath, { fpsNum: program.fpsNum, fpsDen: program.fpsDen }, signal)
      const mappings = job.submission.keyPoints.map(point => {
        const clipTimeUs = point.captureTimeUs - actualStart
        const clipFrameIndex = roundRatio(clipTimeUs * BigInt(video.fps.num), 1_000_000n * BigInt(video.fps.den))
        const clipPts = roundRatio(clipTimeUs * BigInt(video.timeBase.den), 1_000_000n * BigInt(video.timeBase.num))
        if (clipFrameIndex >= video.totalFrames || clipTimeUs > video.durationUs) throw new Error('canonical key point mapping exceeds output clip')
        return { submissionKeyPointId: point.id, sequenceIndex: point.sequenceIndex, markerKind: point.markerKind.toLowerCase(), isTerminal: point.isTerminal, clipPts, clipTimeUs, clipFrameIndex }
      })
      const clipKey = `clips/${job.submissionId}/${job.id}.mp4`
      const clipUpload = await uploadFile(storage.client, storage.rallyBucket, clipKey, outputPath, 'video/mp4', { 'x-amz-meta-artifact-kind': 'canonical-clip' })
      const manifest = { schema_version: '1.0.0', clip_job_id: job.id, submission_id: job.submissionId, requested_start_capture_us: job.requestedStartCaptureUs.toString(), requested_end_capture_us: job.requestedEndCaptureUs.toString(), actual_start_capture_us: actualStart.toString(), actual_end_capture_us: actualEnd.toString(), video: { width: video.width, height: video.height, fps: video.fps, time_base: video.timeBase, total_frames: video.totalFrames.toString(), duration_us: video.durationUs.toString(), has_audio: video.hasAudio }, key_points: mappings.map(mapping => ({ key_point_id: mapping.submissionKeyPointId, sequence_index: mapping.sequenceIndex, marker_kind: mapping.markerKind, is_terminal: mapping.isTerminal, clip_pts: mapping.clipPts.toString(), clip_time_us: mapping.clipTimeUs.toString(), clip_frame_index: mapping.clipFrameIndex.toString() })) }
      const manifestPath = join(directory, 'timing-manifest.json')
      await writeFile(manifestPath, `${stableJson(manifest)}\n`, 'utf8')
      const manifestKey = `clips/${job.submissionId}/${job.id}.timing.json`
      const manifestUpload = await uploadFile(storage.client, storage.rallyBucket, manifestKey, manifestPath, 'application/json', { 'x-amz-meta-artifact-kind': 'timing-manifest', 'x-amz-meta-internal-schema-version': '1.0.0' })

      await database.$transaction(async (tx) => {
        const clipAsset = await tx.mediaAsset.create({ data: { kind: MediaAssetKind.CANONICAL_CLIP, bucket: storage.rallyBucket, objectKey: clipKey, contentType: 'video/mp4', byteLength: clipUpload.byteLength, sha256: clipUpload.sha256, internalSchemaVersion: '1.0.0', state: 'READY', readyAt: new Date() } })
        const timingAsset = await tx.mediaAsset.create({ data: { kind: MediaAssetKind.TIMING_MANIFEST, bucket: storage.rallyBucket, objectKey: manifestKey, contentType: 'application/json', byteLength: manifestUpload.byteLength, sha256: manifestUpload.sha256, internalSchemaVersion: '1.0.0', state: 'READY', readyAt: new Date() } })
        await tx.clipKeyPointMapping.createMany({ data: mappings.map(mapping => ({ clipJobId: job.id, submissionKeyPointId: mapping.submissionKeyPointId, clipPts: mapping.clipPts, clipTimeUs: mapping.clipTimeUs, clipFrameIndex: mapping.clipFrameIndex })) })
        await tx.clipJob.update({ where: { id: job.id }, data: { status: JobStatus.COMPLETED, actualStartCaptureUs: actualStart, actualEndCaptureUs: actualEnd, clipAssetId: clipAsset.id, timingManifestAssetId: timingAsset.id, leasedUntil: null, completedAt: new Date() } })
        const integration = await tx.aiIntegration.findFirst({ where: { enabled: true }, orderBy: { createdAt: 'asc' } })
        if (!integration) {
          await tx.rally.update({ where: { id: job.submission.rallyId }, data: { processingStatus: ProcessingStatus.FAILED } })
          return
        }
        const aiJobId = randomUUID()
        const token = callbackToken(callbackSecret, aiJobId)
        const expiresAt = new Date(Date.now() + 24 * 60 * 60_000)
        const basePayload = { schema_version: integration.jobSchemaVersion, ai_job_id: aiJobId, rally_submission_id: job.submissionId, rally_id: job.submission.rallyId, match_id: job.submission.rally.matchId, annotation_revision: job.submission.annotationRevision.toString(), clip: { clip_asset_id: clipAsset.id, sha256: clipUpload.sha256, byte_length: clipUpload.byteLength.toString(), content_type: 'video/mp4', video: manifest.video }, key_points: manifest.key_points, outcome: { score_resolution: job.submission.scoreResolutionState.toLowerCase(), scoring_court_side: job.submission.scoringCourtSide?.toLowerCase() ?? null } }
        await tx.aiJob.create({ data: { id: aiJobId, integrationId: integration.id, submissionId: job.submissionId, clipJobId: job.id, idempotencyKey: `${integration.id}:${job.submissionId}:${job.id}`, requestPayload: basePayload, requestPayloadHash: sha256Hex(stableJson(basePayload)), jobSchemaVersion: integration.jobSchemaVersion, callbackTokenHash: sha256Hex(token), callbackTokenExpiresAt: expiresAt } })
        await tx.rally.update({ where: { id: job.submission.rallyId }, data: { processingStatus: ProcessingStatus.AI_QUEUED } })
      })
      return true
    }
    catch (error) {
      await failClipJob(database, claimed.id, error)
      return true
    }
    finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  return createPollingLifecycle(processNext, { onError: error => console.error('clip-worker loop error', error), disconnect: () => database.$disconnect() })
}
