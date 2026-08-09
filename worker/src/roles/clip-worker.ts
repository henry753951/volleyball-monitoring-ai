import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismaClient } from '@volleyball-monitoring/db'
import { JobStatus, MediaAssetKind, ProcessingStatus } from '@volleyball-monitoring/db/client'
import { parseSampleIndexDocument } from '@volleyball-monitoring/media/sample-index'
import {
  buildCanonicalClipFfmpegArgs,
  mapClipKeyPoint,
  parseCanonicalClipProbe,
  selectCanonicalClipRange,
  type OutputProbePayload,
} from '../media/clip-timing.js'
import { createNodeProbeRunner } from '../media/ffprobe.js'
import { callbackToken, sha256Hex, stableJson } from '../workflow/crypto.js'
import { appendVerifiedObject, createWorkflowMinio, readVerifiedObject, uploadFile } from '../workflow/minio.js'
import { createPollingLifecycle } from '../workflow/poller.js'

const runner = createNodeProbeRunner()
const leaseMs = 5 * 60_000

async function runCommand(executable: string, args: string[], signal: AbortSignal) {
  const result = await runner(executable, args, { shell: false, timeoutMs: 10 * 60_000, maxOutputBytes: 4_000_000, signal })
  if (result.code !== 0) throw new Error(`${executable} failed: ${result.stderr.slice(-1_000)}`)
  return result.stdout
}

async function probeCanonicalClip(filePath: string, fallback: { fpsNum: number; fpsDen: number }, signal: AbortSignal) {
  const output = await runCommand('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,width,height,avg_frame_rate,time_base:frame=media_type,pts,pkt_duration,key_frame',
    '-of', 'json',
    filePath,
  ], signal)
  return { payload: JSON.parse(output) as OutputProbePayload, fallback }
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

export function createClipWorker(
  database: PrismaClient,
  options: {
    idleMs?: number
    disconnectOnStop?: boolean
    onError?: (error: unknown) => void
  } = {},
) {
  const storage = createWorkflowMinio()
  const callbackSecret = process.env.AI_CALLBACK_TOKEN_SECRET ?? ''

  async function processNext(signal: AbortSignal): Promise<boolean> {
    const claimed = await claimClipJob(database)
    if (!claimed) return false
    const directory = await mkdtemp(join(tmpdir(), 'volleyball-clip-'))
    const cancellation = new AbortController()
    let checkingCancellation = false
    const cancellationMonitor = setInterval(() => {
      if (checkingCancellation || cancellation.signal.aborted) return
      checkingCancellation = true
      void database.clipJob.findUnique({ where: { id: claimed.id }, select: { status: true } })
        .then(current => {
          if (!current || current.status === JobStatus.CANCELLED || current.status === JobStatus.SUPERSEDED) cancellation.abort('processing clip cancelled')
        })
        .finally(() => { checkingCancellation = false })
    }, 500)
    const jobSignal = AbortSignal.any([signal, cancellation.signal])
    const ensureActive = async () => {
      const current = await database.clipJob.findUnique({ where: { id: claimed.id }, select: { status: true } })
      if (!current || current.status !== JobStatus.RUNNING) {
        cancellation.abort('processing clip cancelled')
        throw new Error('PROCESSING_CANCELLED')
      }
    }
    try {
      const job = await database.clipJob.findUniqueOrThrow({
        where: { id: claimed.id },
        include: { submission: { include: { rally: { include: { program: true } }, keyPoints: { orderBy: { sequenceIndex: 'asc' } } } } },
      })
      const program = job.submission.rally.program
      const candidates = await database.dvrSegment.findMany({
        where: { dvrProgramId: program.id, isGap: false, readyAt: { not: null }, captureStartUs: { lt: job.requestedEndCaptureUs }, captureEndUs: { gt: job.requestedStartCaptureUs } },
        orderBy: { sequenceNumber: 'asc' },
        include: { initAsset: true, mediaAsset: true, sampleIndexAsset: true, captureEpoch: true },
      })
      const firstPoint = job.submission.keyPoints[0]
      const anchorSegment = firstPoint ? candidates.find(segment => firstPoint.captureTimeUs >= segment.captureStartUs && firstPoint.captureTimeUs < segment.captureEndUs) : null
      const segments = anchorSegment ? candidates.filter(segment => segment.discontinuitySequence === anchorSegment.discontinuitySequence) : []
      if (!segments.length || segments.some(segment => !segment.initAsset || !segment.mediaAsset || !segment.sampleIndexAsset)) throw new Error('requested DVR range is not ready')
      for (let index = 1; index < segments.length; index += 1) {
        if (segments[index]!.discontinuitySequence !== segments[0]!.discontinuitySequence || segments[index]!.captureStartUs > segments[index - 1]!.captureEndUs) throw new Error('canonical clip cannot cross a gap or discontinuity')
      }
      const indexedSegments = await Promise.all(segments.map(async (segment) => {
        const document = JSON.parse((await readVerifiedObject(storage.client, segment.sampleIndexAsset!)).toString('utf8'))
        const index = parseSampleIndexDocument(document, {
          epochId: segment.captureEpoch.id,
          sourcePtsOrigin: segment.captureEpoch.sourcePtsOrigin,
          captureTimeOriginUs: segment.captureEpoch.captureTimeOriginUs,
          captureFrameOrigin: segment.captureEpoch.captureFrameOrigin,
          timeBase: {
            num: BigInt(segment.captureEpoch.sourceTimeBaseNum),
            den: BigInt(segment.captureEpoch.sourceTimeBaseDen),
          },
        })
        return {
          id: segment.id,
          captureEpochId: segment.captureEpochId,
          captureStartUs: segment.captureStartUs,
          captureEndUs: segment.captureEndUs,
          sourcePtsStart: segment.sourcePtsStart,
          sourcePtsEnd: segment.sourcePtsEnd,
          firstFrameIndex: segment.firstFrameIndex,
          frameCount: segment.frameCount,
          index,
        }
      }))
      const selection = selectCanonicalClipRange(
        indexedSegments,
        job.requestedStartCaptureUs,
        job.requestedEndCaptureUs,
        job.submission.keyPoints,
      )
      const actualStart = selection.actualStartCaptureUs
      const actualEnd = selection.actualEndCaptureUs

      const sourceListPath = join(directory, 'source.concat.txt')
      const sourceSegmentPaths: string[] = []
      for (const [index, segment] of segments.entries()) {
        const sourceSegmentPath = join(directory, `source-${index.toString().padStart(4, '0')}.mp4`)
        await appendVerifiedObject(storage.client, segment.initAsset!, sourceSegmentPath)
        await appendVerifiedObject(storage.client, segment.mediaAsset!, sourceSegmentPath)
        sourceSegmentPaths.push(sourceSegmentPath)
      }
      await writeFile(
        sourceListPath,
        `${sourceSegmentPaths.map(filePath => `file '${filePath}'`).join('\n')}\n`,
        'utf8',
      )
      await ensureActive()
      const outputPath = join(directory, 'canonical.mp4')
      await runCommand('ffmpeg', buildCanonicalClipFfmpegArgs(sourceListPath, outputPath, selection, 'concat'), jobSignal)
      const probe = await probeCanonicalClip(outputPath, { fpsNum: program.fpsNum, fpsDen: program.fpsDen }, jobSignal)
      const video = parseCanonicalClipProbe(probe.payload, selection.sourceSamples.length, probe.fallback)
      const mappings = job.submission.keyPoints.map(point => {
        const ordinal = selection.keyPointOrdinals.get(point.id)
        if (ordinal === undefined) throw new Error(`immutable key point ${point.id} has no selected source frame`)
        return {
          submissionKeyPointId: point.id,
          sequenceIndex: point.sequenceIndex,
          markerKind: point.markerKind.toLowerCase(),
          isTerminal: point.isTerminal,
          captureEpochId: point.captureEpochId,
          sourcePts: point.sourcePts,
          captureTimeUs: point.captureTimeUs,
          captureFrameIndex: point.captureFrameIndex,
          ...mapClipKeyPoint(point.id, ordinal, video),
        }
      })
      const clipKey = `clips/${job.submissionId}/${job.id}.mp4`
      await ensureActive()
      const clipUpload = await uploadFile(storage.client, storage.rallyBucket, clipKey, outputPath, 'video/mp4', { 'x-amz-meta-artifact-kind': 'canonical-clip' })
      const aiKeyPoints = mappings.map(mapping => ({ key_point_id: mapping.submissionKeyPointId, sequence_index: mapping.sequenceIndex, marker_kind: mapping.markerKind, is_terminal: mapping.isTerminal, clip_pts: mapping.clipPts.toString(), clip_time_us: mapping.clipTimeUs.toString(), clip_frame_index: mapping.clipFrameIndex.toString() }))
      const frameMap = selection.sourceSamples.map((sample, ordinal) => ({
        capture_epoch_id: sample.captureEpochId,
        source_pts: sample.sourcePts.toString(),
        source_duration_pts: sample.durationPts.toString(),
        capture_time_us: sample.captureTimeUs.toString(),
        capture_frame_index: sample.captureFrameIndex.toString(),
        clip_pts: video.frames[ordinal]!.pts.toString(),
        clip_duration_pts: video.frames[ordinal]!.durationPts.toString(),
        clip_time_us: mapClipKeyPoint(`frame-${ordinal}`, ordinal, video).clipTimeUs.toString(),
        clip_frame_index: ordinal.toString(),
      }))
      const manifest = { schema_version: '1.1.0', clip_job_id: job.id, submission_id: job.submissionId, requested_start_capture_us: job.requestedStartCaptureUs.toString(), requested_end_capture_us: job.requestedEndCaptureUs.toString(), actual_start_capture_us: actualStart.toString(), actual_end_capture_us: actualEnd.toString(), source_time_base: { num: selection.sourceTimeBase.num.toString(), den: selection.sourceTimeBase.den.toString() }, video: { width: video.width, height: video.height, fps: video.fps, time_base: video.timeBase, total_frames: video.totalFrames.toString(), duration_us: video.durationUs.toString(), has_audio: video.hasAudio }, frame_map: frameMap, key_points: mappings.map(mapping => ({ key_point_id: mapping.submissionKeyPointId, sequence_index: mapping.sequenceIndex, marker_kind: mapping.markerKind, is_terminal: mapping.isTerminal, capture_epoch_id: mapping.captureEpochId, source_pts: mapping.sourcePts.toString(), source_time_base: { num: selection.sourceTimeBase.num.toString(), den: selection.sourceTimeBase.den.toString() }, capture_time_us: mapping.captureTimeUs.toString(), capture_frame_index: mapping.captureFrameIndex.toString(), clip_pts: mapping.clipPts.toString(), clip_time_us: mapping.clipTimeUs.toString(), clip_frame_index: mapping.clipFrameIndex.toString() })) }
      const manifestPath = join(directory, 'timing-manifest.json')
      await writeFile(manifestPath, `${stableJson(manifest)}\n`, 'utf8')
      const manifestKey = `clips/${job.submissionId}/${job.id}.timing.json`
      const manifestUpload = await uploadFile(storage.client, storage.rallyBucket, manifestKey, manifestPath, 'application/json', { 'x-amz-meta-artifact-kind': 'timing-manifest', 'x-amz-meta-internal-schema-version': '1.1.0' })

      await database.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "ClipJob" WHERE id = ${job.id}::uuid FOR UPDATE`
        const current = await tx.clipJob.findUnique({ where: { id: job.id }, select: { status: true } })
        if (!current || current.status !== JobStatus.RUNNING) throw new Error('PROCESSING_CANCELLED')
        const clipAsset = await tx.mediaAsset.create({ data: { kind: MediaAssetKind.CANONICAL_CLIP, bucket: storage.rallyBucket, objectKey: clipKey, contentType: 'video/mp4', byteLength: clipUpload.byteLength, sha256: clipUpload.sha256, internalSchemaVersion: '1.0.0', state: 'READY', readyAt: new Date() } })
        const timingAsset = await tx.mediaAsset.create({ data: { kind: MediaAssetKind.TIMING_MANIFEST, bucket: storage.rallyBucket, objectKey: manifestKey, contentType: 'application/json', byteLength: manifestUpload.byteLength, sha256: manifestUpload.sha256, internalSchemaVersion: '1.1.0', state: 'READY', readyAt: new Date() } })
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
        const basePayload = { schema_version: integration.jobSchemaVersion, ai_job_id: aiJobId, rally_submission_id: job.submissionId, rally_id: job.submission.rallyId, match_id: job.submission.rally.matchId, annotation_revision: job.submission.annotationRevision.toString(), clip: { clip_asset_id: clipAsset.id, sha256: clipUpload.sha256, byte_length: clipUpload.byteLength.toString(), content_type: 'video/mp4', video: manifest.video }, key_points: aiKeyPoints, outcome: { score_resolution: job.submission.scoreResolutionState.toLowerCase(), scoring_court_side: job.submission.scoringCourtSide?.toLowerCase() ?? null } }
        await tx.aiJob.create({ data: { id: aiJobId, integrationId: integration.id, submissionId: job.submissionId, clipJobId: job.id, idempotencyKey: `${integration.id}:${job.submissionId}:${job.id}`, requestPayload: basePayload, requestPayloadHash: sha256Hex(stableJson(basePayload)), jobSchemaVersion: integration.jobSchemaVersion, callbackTokenHash: sha256Hex(token), callbackTokenExpiresAt: expiresAt } })
        await tx.rally.update({ where: { id: job.submission.rallyId }, data: { processingStatus: ProcessingStatus.AI_QUEUED } })
      })
      return true
    }
    catch (error) {
      if (!cancellation.signal.aborted && !(error instanceof Error && error.message === 'PROCESSING_CANCELLED')) await failClipJob(database, claimed.id, error)
      return true
    }
    finally {
      clearInterval(cancellationMonitor)
      await rm(directory, { recursive: true, force: true })
    }
  }

  return createPollingLifecycle(processNext, {
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
    onError: (error) => {
      console.error('clip-worker loop error', error)
      options.onError?.(error)
    },
    ...(options.disconnectOnStop === false ? {} : { disconnect: () => database.$disconnect() }),
  })
}
