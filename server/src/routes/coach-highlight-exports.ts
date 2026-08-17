import { createHash } from 'node:crypto'
import { db } from '@volleyball-monitoring/db'
import { ArtifactState, JobStatus, UserRole } from '@volleyball-monitoring/db/client'
import type { FastifyPluginAsync } from 'fastify'
import { Client } from 'minio'
import { z } from 'zod'
import { authenticateDevelopmentAnnotationRequest } from '../realtime/auth.js'

const uuid = z.string().uuid()
const decimal = z.string().regex(/^\d+$/)
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const requestSchema = z.object({
  schema_version: z.literal('1.0.0'),
  source_fingerprint: sha256,
  subject_label: z.string().trim().min(1).max(120),
  filter_label: z.string().trim().min(1).max(80),
  events: z
    .array(
      z.object({
        event_id: z.string().min(1).max(240),
        rally_id: uuid,
        clip_job_id: uuid,
        clip_duration_us: decimal,
        anchor_time_us: decimal,
        set_number: z.number().int().positive().max(99),
        rally_ordinal: z.number().int().positive().max(99_999),
        action_key: z.string().min(1).max(80),
        action_label: z.string().trim().min(1).max(80),
      }),
    )
    .min(1)
    .max(100),
})

function sourceFingerprint(input: z.infer<typeof requestSchema>) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.subject_label,
        input.filter_label,
        input.events.map(event => [
          event.event_id,
          event.rally_id,
          event.clip_job_id,
          event.clip_duration_us,
          event.anchor_time_us,
          event.set_number,
          event.rally_ordinal,
          event.action_key,
          event.action_label,
        ]),
      ]),
    )
    .digest('hex')
}

function storageClient() {
  const endpoint = new URL(process.env.MINIO_ENDPOINT ?? 'http://minio:9000')
  const accessKey = process.env.MINIO_ACCESS_KEY
  const secretKey = process.env.MINIO_SECRET_KEY
  if (!accessKey || !secretKey) throw new Error('MinIO credentials are required')
  return new Client({
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)),
    useSSL: endpoint.protocol === 'https:',
    accessKey,
    secretKey,
    pathStyle: true,
  })
}

function responseDocument(
  matchId: string,
  job: {
    id: string
    status: JobStatus
    progress: number
    errorCode: string | null
    errorMessage: string | null
    completedAt: Date | null
    createdAt: Date
    requestPayload: unknown
    outputAssetId: string | null
    sourceFingerprint: string | null
  },
) {
  const payload = job.requestPayload as { events?: unknown[] }
  return {
    schema_version: '1.0.0',
    id: job.id,
    status: job.status.toLowerCase(),
    progress: Math.max(0, Math.min(100, job.progress)),
    total_events: Array.isArray(payload.events) ? payload.events.length : 0,
    error: job.errorCode
      ? { code: job.errorCode, message: job.errorMessage ?? '影片輸出失敗' }
      : null,
    completed_at: job.completedAt?.toISOString() ?? null,
    created_at: job.createdAt.toISOString(),
    source_fingerprint: job.sourceFingerprint,
    download_filename: `volleyball-highlight-${job.id.slice(0, 8)}.mp4`,
    download_url:
      job.status === JobStatus.COMPLETED && job.outputAssetId
        ? `/api/v1/matches/${matchId}/highlight-exports/${job.id}/download`
        : null,
  }
}

export const coachHighlightExportRoutes: FastifyPluginAsync = async app => {
  // Restore the exact S3-backed reel for the current analytics source version.
  app.get<{ Params: { matchId: string }; Querystring: { source_fingerprint?: string } }>(
    '/api/v1/matches/:matchId/highlight-exports',
    async (request, reply) => {
      const identity = await authenticateDevelopmentAnnotationRequest(request, db)
      if (!identity) return reply.status(401).send({ code: 'UNAUTHENTICATED' })
      const fingerprint = sha256.safeParse(request.query.source_fingerprint)
      if (!fingerprint.success) return reply.status(400).send({ code: 'INVALID_FINGERPRINT' })
      const job = await db.coachHighlightExportJob.findFirst({
        where: {
          matchId: request.params.matchId,
          sourceFingerprint: fingerprint.data,
          ...(identity.role === UserRole.ADMIN ? {} : { requestedByUserId: identity.userId }),
        },
        orderBy: { createdAt: 'desc' },
      })
      if (!job) return reply.status(204).send()
      return responseDocument(request.params.matchId, job)
    },
  )

  app.post<{ Params: { matchId: string } }>(
    '/api/v1/matches/:matchId/highlight-exports',
    async (request, reply) => {
      const identity = await authenticateDevelopmentAnnotationRequest(request, db)
      if (!identity) return reply.status(401).send({ code: 'UNAUTHENTICATED' })
      const parsed = requestSchema.safeParse(request.body)
      if (!parsed.success)
        return reply.status(400).send({ code: 'INVALID_REQUEST', issues: parsed.error.issues })
      if (sourceFingerprint(parsed.data) !== parsed.data.source_fingerprint)
        return reply.status(400).send({ code: 'INVALID_FINGERPRINT' })

      const match = await db.match.findFirst({
        where: {
          id: request.params.matchId,
          ...(identity.role === UserRole.ADMIN
            ? {}
            : { members: { some: { userId: identity.userId } } }),
        },
        select: { id: true },
      })
      if (!match) return reply.status(404).send({ code: 'NOT_FOUND' })

      const requestedClipIds = [...new Set(parsed.data.events.map(event => event.clip_job_id))]
      const clips = await db.clipJob.findMany({
        where: {
          id: { in: requestedClipIds },
          status: JobStatus.COMPLETED,
          submission: { rally: { matchId: match.id, voidedAt: null } },
          clipAsset: { state: ArtifactState.READY, deletedAt: null },
        },
        select: {
          id: true,
          actualStartCaptureUs: true,
          actualEndCaptureUs: true,
          clipAsset: {
            select: {
              id: true,
              bucket: true,
              objectKey: true,
              contentType: true,
              byteLength: true,
              sha256: true,
            },
          },
          submission: { select: { rallyId: true } },
        },
      })
      const clipsById = new Map(clips.map(clip => [clip.id, clip]))
      const normalizedEvents = []
      for (const event of parsed.data.events) {
        const clip = clipsById.get(event.clip_job_id)
        if (!clip?.clipAsset || clip.submission.rallyId !== event.rally_id)
          return reply.status(409).send({ code: 'CLIP_UNAVAILABLE', event_id: event.event_id })
        const canonicalDuration =
          clip.actualStartCaptureUs !== null && clip.actualEndCaptureUs !== null
            ? clip.actualEndCaptureUs - clip.actualStartCaptureUs
            : BigInt(event.clip_duration_us)
        if (canonicalDuration <= 0n || BigInt(event.anchor_time_us) > canonicalDuration)
          return reply.status(409).send({ code: 'CLIP_WINDOW_INVALID', event_id: event.event_id })
        normalizedEvents.push({
          ...event,
          clip_duration_us: canonicalDuration.toString(),
          source_asset: {
            id: clip.clipAsset.id,
            bucket: clip.clipAsset.bucket,
            object_key: clip.clipAsset.objectKey,
            content_type: clip.clipAsset.contentType,
            byte_length: clip.clipAsset.byteLength?.toString() ?? null,
            sha256: clip.clipAsset.sha256,
          },
        })
      }

      const payload = { ...parsed.data, events: normalizedEvents }
      const idempotencyKey = createHash('sha256')
        .update(`${identity.userId}\n${JSON.stringify(payload)}`)
        .digest('hex')
      const existing = await db.coachHighlightExportJob.findUnique({ where: { idempotencyKey } })
      const job = existing
        ? existing.status === JobStatus.FAILED
          ? await db.coachHighlightExportJob.update({
              where: { id: existing.id },
              data: {
                status: JobStatus.QUEUED,
                progress: 0,
                attemptCount: 0,
                availableAt: new Date(),
                leasedUntil: null,
                errorCode: null,
                errorMessage: null,
                startedAt: null,
                completedAt: null,
              },
            })
          : existing
        : await db.coachHighlightExportJob.create({
            data: {
              matchId: match.id,
              requestedByUserId: identity.userId,
              idempotencyKey,
              sourceFingerprint: parsed.data.source_fingerprint,
              requestPayload: payload,
            },
          })
      return reply
        .status(job.status === JobStatus.COMPLETED ? 200 : 202)
        .send(responseDocument(match.id, job))
    },
  )

  app.get<{ Params: { matchId: string; jobId: string } }>(
    '/api/v1/matches/:matchId/highlight-exports/:jobId',
    async (request, reply) => {
      const identity = await authenticateDevelopmentAnnotationRequest(request, db)
      if (!identity) return reply.status(401).send({ code: 'UNAUTHENTICATED' })
      const job = await db.coachHighlightExportJob.findFirst({
        where: {
          id: request.params.jobId,
          matchId: request.params.matchId,
          ...(identity.role === UserRole.ADMIN ? {} : { requestedByUserId: identity.userId }),
        },
      })
      if (!job) return reply.status(404).send({ code: 'NOT_FOUND' })
      return responseDocument(request.params.matchId, job)
    },
  )

  app.get<{ Params: { matchId: string; jobId: string } }>(
    '/api/v1/matches/:matchId/highlight-exports/:jobId/download',
    async (request, reply) => {
      const identity = await authenticateDevelopmentAnnotationRequest(request, db)
      if (!identity) return reply.status(401).send({ code: 'UNAUTHENTICATED' })
      const job = await db.coachHighlightExportJob.findFirst({
        where: {
          id: request.params.jobId,
          matchId: request.params.matchId,
          status: JobStatus.COMPLETED,
          ...(identity.role === UserRole.ADMIN ? {} : { requestedByUserId: identity.userId }),
          outputAsset: { state: ArtifactState.READY, deletedAt: null },
        },
        select: { outputAsset: true },
      })
      const asset = job?.outputAsset
      if (!asset?.byteLength || !asset.sha256 || asset.byteLength > BigInt(Number.MAX_SAFE_INTEGER))
        return reply.status(404).send({ code: 'NOT_FOUND' })
      const total = Number(asset.byteLength)
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
      const storage = storageClient()
      reply
        .header('Accept-Ranges', 'bytes')
        .header('Cache-Control', 'private, no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Disposition', downloadDisposition(request.params.jobId))
        .header('ETag', `"${asset.sha256}"`)
        .type(asset.contentType)
      if (range) {
        const start = Number(range[1])
        const end = Math.min(range[2] ? Number(range[2]) : total - 1, total - 1)
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start < 0 ||
          start > end ||
          start >= total
        )
          return reply.status(416).header('Content-Range', `bytes */${total}`).send()
        reply
          .status(206)
          .header('Content-Range', `bytes ${start}-${end}/${total}`)
          .header('Content-Length', String(end - start + 1))
        return reply.send(
          await storage.getPartialObject(asset.bucket, asset.objectKey, start, end - start + 1),
        )
      }
      reply.header('Content-Length', String(total))
      return reply.send(await storage.getObject(asset.bucket, asset.objectKey))
    },
  )
}

function downloadDisposition(jobId: string) {
  const fileName = `volleyball-highlight-${jobId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 8)}.mp4`
  return `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}
