import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import type { PrismaClient } from '@volleyball-monitoring/db'
import { Prisma, UserRole } from '@volleyball-monitoring/db/client'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { AnnotationIdentity } from '../services/annotation-command.js'
import { failCaptureStartup, startCapture } from '../services/capture-processing.js'
import { scheduleMediaSourceWork, type MediaSourceWorkRequest } from '../media/media-source-work.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'www.youtu.be',
])
const YoutubeRequest = z
  .object({
    match_id: z.string().regex(UUID),
    source_label: z.string().trim().min(1).max(120).optional(),
    source_url: z.string().trim().url().max(2_048),
  })
  .strict()
const RtmpRequest = z
  .object({
    match_id: z.string().regex(UUID),
    source_label: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
type MediaSourceRouteDependencies = {
  authenticate(request: FastifyRequest): Promise<AnnotationIdentity | null>
  database: PrismaClient
  importRoot: string
  recordingRoot?: string
  scheduleWork?: (database: PrismaClient, request: MediaSourceWorkRequest) => Promise<unknown>
  startCapture?: typeof startCapture
  failCaptureStartup?: typeof failCaptureStartup
  rtmpPublicUrl?: string
}

async function youtubeAuthWorkerRequest(path: string, method: 'GET' | 'POST' = 'GET') {
  const base = process.env.YOUTUBE_AUTH_WORKER_URL
  if (!base) throw new Error('YOUTUBE_AUTH_WORKER_URL is not configured')
  const headers: Record<string, string> = {}
  if (process.env.YOUTUBE_AUTH_PROBE_TOKEN) {
    headers['x-youtube-auth-token'] = process.env.YOUTUBE_AUTH_PROBE_TOKEN
  }
  const response = await fetch(new URL(path, `${base.replace(/\/$/, '')}/`), {
    method,
    headers,
  })
  const body = await response.json().catch(() => null)
  if (!response.ok)
    throw new Error(
      typeof body?.message === 'string'
        ? body.message
        : `YouTube auth service unavailable (${response.status})`,
    )
  return body
}

function operator(identity: AnnotationIdentity | null) {
  if (!identity) return null
  if (identity.role !== UserRole.ADMIN && identity.role !== UserRole.OPERATOR) return null
  return { id: identity.userId, role: identity.role }
}

function youtubeUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || !YOUTUBE_HOSTS.has(url.hostname.toLowerCase()))
    throw new TypeError('請輸入有效的 YouTube 網址')
  if (!url.pathname || url.pathname === '/')
    throw new TypeError('請輸入完整的 YouTube 影片或直播網址')
  url.hash = ''
  return url.toString()
}

function ingestPath(matchId: string, kind: 'youtube' | 'local_mp4') {
  return `${kind}-${matchId}-${randomUUID()}`
}

function rtmpPublicBase(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'rtmp:' || !url.hostname || url.search || url.hash)
    throw new TypeError('OME_RTMP_PUBLIC_URL must be an rtmp:// URL')
  url.pathname = url.pathname.replace(/\/+$/, '')
  if (!url.pathname) url.pathname = '/app'
  return url.toString().replace(/\/+$/, '')
}

function rtmpStreamKey(): string {
  return randomBytes(24).toString('base64url')
}

function rtmpCredentials(streamKey: string, publicBase: string) {
  return {
    rtmp_url: publicBase,
    publish_url: `${publicBase}/${encodeURIComponent(streamKey)}`,
    stream_key: streamKey,
  }
}

function capturePayload(capture: Awaited<ReturnType<typeof startCapture>>) {
  return {
    capture_session: {
      health: capture.health.toLowerCase(),
      id: capture.id,
      ingest_path: capture.ingestPath,
      match_id: capture.matchId,
      source_kind: capture.sourceKind,
      source_label: capture.sourceLabel,
      status: capture.status.toLowerCase(),
    },
  }
}

export function mediaSourceRoutes(dependencies: MediaSourceRouteDependencies): FastifyPluginAsync {
  const importRoot = resolve(dependencies.importRoot)
  const recordingRoot = dependencies.recordingRoot ? resolve(dependencies.recordingRoot) : null
  const createCapture = dependencies.startCapture ?? startCapture
  const failCapture = dependencies.failCaptureStartup ?? failCaptureStartup
  const scheduleWork = dependencies.scheduleWork ?? scheduleMediaSourceWork
  const publicRtmpBase = rtmpPublicBase(
    dependencies.rtmpPublicUrl ?? process.env.OME_RTMP_PUBLIC_URL ?? 'rtmp://localhost:1935/app',
  )
  return async app => {
    const retrySource = async (
      captureSessionId: string,
      identity: { id: string; role: UserRole },
      allowedSourceKinds?: string[],
    ) =>
      dependencies.database.$transaction(async tx => {
        await tx.$queryRaw`
          SELECT pg_advisory_xact_lock(
            hashtextextended(CAST(${`capture-media:${captureSessionId}`} AS text), 0)
          )::text AS lock
        `
        const capture = await tx.captureSession.findFirst({
          select: { id: true, status: true, sourceKind: true },
          where: {
            id: captureSessionId,
            ...(allowedSourceKinds ? { sourceKind: { in: allowedSourceKinds } } : {}),
            match: {
              deletionRequestedAt: null,
              ...(identity.role === UserRole.ADMIN
                ? {}
                : {
                    members: {
                      some: {
                        userId: identity.id,
                        role: { in: [UserRole.ADMIN, UserRole.OPERATOR] },
                      },
                    },
                  }),
            },
          },
        })
        const work = capture
          ? await tx.mediaSourceWork.findUnique({ where: { captureSessionId: capture.id } })
          : null
        if (!capture || !work) return null
        if (['RUNNING', 'DRAINING', 'STOP_REQUESTED'].includes(work.status))
          throw new Error('MEDIA_SOURCE_ACTIVE')
        if (work.status === 'COMPLETED' || capture.status === 'FINISHED')
          throw new Error('MEDIA_SOURCE_COMPLETED')

        await tx.mediaSourceWork.update({
          data: {
            availableAt: new Date(),
            authMetadata: Prisma.JsonNull,
            lastErrorCode: null,
            lastHeartbeatAt: null,
            leaseExpiresAt: null,
            leaseOwner: null,
            status: 'REQUESTED',
          },
          where: { id: work.id },
        })
        await tx.captureSession.update({
          data: {
            completionExpectedSegments: null,
            completionRequestedAt: null,
            endedAt: null,
            health: 'STARTING',
            sourceOnline: false,
            startedAt: null,
            status: 'STARTING',
          },
          where: { id: capture.id },
        })
        await tx.dvrProgram.updateMany({
          data: { status: 'STARTING' },
          where: { captureSessionId: capture.id, status: 'FAILED' },
        })
        return {
          attempt: work.attempts + 1,
          capture_session_id: capture.id,
          source_kind: capture.sourceKind,
        }
      })

    app.get('/api/v1/media-sources/youtube-auth/status', async (request, reply) => {
      const identity = operator(await dependencies.authenticate(request))
      if (!identity) return reply.status(401).send({ code: 'UNAUTHENTICATED' })
      try {
        return reply
          .header('cache-control', 'no-store')
          .send(await youtubeAuthWorkerRequest('/internal/youtube-auth/status'))
      } catch (error) {
        return reply.status(503).send({
          code: 'YOUTUBE_AUTH_UNAVAILABLE',
          message: error instanceof Error ? error.message : 'YouTube 登入狀態無法取得',
        })
      }
    })

    app.post('/api/v1/media-sources/youtube-auth/refresh', async (request, reply) => {
      const identity = operator(await dependencies.authenticate(request))
      if (!identity) return reply.status(401).send({ code: 'UNAUTHENTICATED' })
      try {
        return reply
          .header('cache-control', 'no-store')
          .send(await youtubeAuthWorkerRequest('/internal/youtube-auth/refresh', 'POST'))
      } catch (error) {
        return reply.status(503).send({
          code: 'YOUTUBE_AUTH_UNAVAILABLE',
          message: error instanceof Error ? error.message : 'YouTube Cookie 檢查失敗',
        })
      }
    })

    app.post('/api/v1/media-sources/youtube', async (request, reply) => {
      const identity = operator(await dependencies.authenticate(request))
      if (!identity) return reply.status(401).send({ code: 'UNAUTHENTICATED' })
      const parsed = YoutubeRequest.safeParse(request.body)
      if (!parsed.success)
        return reply.status(400).send({ code: 'BAD_USER_INPUT', message: 'YouTube 來源資料不完整' })
      let sourceUrl: string
      try {
        sourceUrl = youtubeUrl(parsed.data.source_url)
      } catch (error) {
        return reply.status(400).send({
          code: 'BAD_USER_INPUT',
          message: error instanceof Error ? error.message : 'YouTube 網址無效',
        })
      }

      const path = ingestPath(parsed.data.match_id, 'youtube')
      const capture = await createCapture(dependencies.database, identity, {
        ingestPath: path,
        matchId: parsed.data.match_id,
        sourceConfigSecretRef: `media-source://youtube/${basename(path)}`,
        sourceKind: 'youtube',
        sourceLabel: parsed.data.source_label ?? 'YouTube',
      })
      try {
        await scheduleWork(dependencies.database, {
          captureSessionId: capture.id,
          sourceKind: 'youtube',
          sourceUrl,
        })
      } catch (error) {
        await failCapture(
          dependencies.database,
          capture.id,
          error instanceof Error ? error.message : 'MEDIA_SOURCE_START_FAILED',
        ).catch(() => undefined)
        return reply.status(502).send({
          code: 'SOURCE_START_FAILED',
          message: '無法啟動 YouTube 來源，場次已保留，可稍後重試。',
        })
      }
      return reply.status(202).send(capturePayload(capture))
    })

    app.get('/api/v1/media-sources/youtube/:capture_session_id/auth', async (request, reply) => {
      const identity = operator(await dependencies.authenticate(request))
      if (!identity) return reply.status(401).send({ code: 'UNAUTHENTICATED' })
      const params = z
        .object({ capture_session_id: z.string().regex(UUID) })
        .safeParse(request.params)
      if (!params.success) return reply.status(404).send({ code: 'NOT_FOUND' })
      const capture = await dependencies.database.captureSession.findFirst({
        select: { id: true },
        where: {
          id: params.data.capture_session_id,
          sourceKind: { in: ['youtube', 'youtube_live', 'youtube_vod'] },
          match: {
            deletionRequestedAt: null,
            ...(identity.role === UserRole.ADMIN
              ? {}
              : {
                  members: {
                    some: {
                      userId: identity.id,
                      role: { in: [UserRole.ADMIN, UserRole.OPERATOR] },
                    },
                  },
                }),
          },
        },
      })
      if (!capture) return reply.status(404).send({ code: 'NOT_FOUND' })
      const work = await dependencies.database.mediaSourceWork.findUnique({
        select: { attempts: true, authMetadata: true, lastErrorCode: true, status: true },
        where: { captureSessionId: capture.id },
      })
      if (!work) return reply.status(404).send({ code: 'NOT_FOUND' })
      return reply.header('cache-control', 'no-store').send({
        capture_session_id: capture.id,
        attempt: work.attempts,
        status: work.status.toLowerCase(),
        last_error: work.lastErrorCode,
        auth: work.authMetadata,
      })
    })

    app.post('/api/v1/media-sources/youtube/:capture_session_id/retry', async (request, reply) => {
      const identity = operator(await dependencies.authenticate(request))
      if (!identity) return reply.status(401).send({ code: 'UNAUTHENTICATED' })
      const params = z
        .object({ capture_session_id: z.string().regex(UUID) })
        .safeParse(request.params)
      if (!params.success) return reply.status(404).send({ code: 'NOT_FOUND' })
      try {
        const result = await retrySource(params.data.capture_session_id, identity, [
          'youtube',
          'youtube_live',
          'youtube_vod',
        ])
        if (!result) return reply.status(404).send({ code: 'NOT_FOUND' })
        return reply.status(202).send({ ...result, fresh_resolve: true })
      } catch (error) {
        if (error instanceof Error && error.message === 'MEDIA_SOURCE_ACTIVE')
          return reply.status(409).send({ code: 'MEDIA_SOURCE_ACTIVE' })
        if (error instanceof Error && error.message === 'MEDIA_SOURCE_COMPLETED')
          return reply.status(409).send({ code: 'MEDIA_SOURCE_COMPLETED' })
        throw error
      }
    })

    app.post('/api/v1/media-sources/:capture_session_id/retry', async (request, reply) => {
      const identity = operator(await dependencies.authenticate(request))
      if (!identity) return reply.status(401).send({ code: 'UNAUTHENTICATED' })
      const params = z
        .object({ capture_session_id: z.string().regex(UUID) })
        .safeParse(request.params)
      if (!params.success) return reply.status(404).send({ code: 'NOT_FOUND' })
      try {
        const result = await retrySource(params.data.capture_session_id, identity)
        if (!result) return reply.status(404).send({ code: 'NOT_FOUND' })
        return reply.status(202).send({ ...result, fresh_resolve: true })
      } catch (error) {
        if (error instanceof Error && error.message === 'MEDIA_SOURCE_ACTIVE')
          return reply.status(409).send({ code: 'MEDIA_SOURCE_ACTIVE' })
        if (error instanceof Error && error.message === 'MEDIA_SOURCE_COMPLETED')
          return reply.status(409).send({ code: 'MEDIA_SOURCE_COMPLETED' })
        throw error
      }
    })

    app.delete('/api/v1/media-sources/:capture_session_id', async (request, reply) => {
      const identity = operator(await dependencies.authenticate(request))
      if (!identity) return reply.status(401).send({ code: 'UNAUTHENTICATED' })
      const params = z
        .object({ capture_session_id: z.string().regex(UUID) })
        .safeParse(request.params)
      if (!params.success) return reply.status(404).send({ code: 'NOT_FOUND' })

      try {
        const result = await dependencies.database.$transaction(async tx => {
          await tx.$queryRaw`
            SELECT pg_advisory_xact_lock(
              hashtextextended(CAST(${`capture-media:${params.data.capture_session_id}`} AS text), 0)
            )::text AS lock
          `
          const capture = await tx.captureSession.findFirst({
            select: { id: true, ingestPath: true, status: true, sourceKind: true },
            where: {
              id: params.data.capture_session_id,
              match: {
                deletionRequestedAt: null,
                ...(identity.role === UserRole.ADMIN
                  ? {}
                  : {
                      members: {
                        some: {
                          userId: identity.id,
                          role: { in: [UserRole.ADMIN, UserRole.OPERATOR] },
                        },
                      },
                    }),
              },
            },
          })
          if (!capture) return null

          const work = await tx.mediaSourceWork.findUnique({
            select: { status: true },
            where: { captureSessionId: capture.id },
          })
          if (
            ['STARTING', 'LIVE', 'STOPPING'].includes(capture.status) ||
            ['REQUESTED', 'RUNNING', 'DRAINING', 'STOP_REQUESTED'].includes(work?.status ?? '')
          ) {
            throw new Error('MEDIA_SOURCE_ACTIVE')
          }

          const programs = await tx.dvrProgram.findMany({
            select: { id: true },
            where: { captureSessionId: capture.id },
          })
          const programIds = programs.map(program => program.id)
          const [segmentCount, extentCount, rallyCount] = programIds.length
            ? await Promise.all([
                tx.dvrSegment.count({ where: { dvrProgramId: { in: programIds } } }),
                tx.mediaExtent.count({ where: { captureSessionId: capture.id } }),
                tx.rally.count({ where: { dvrProgramId: { in: programIds } } }),
              ])
            : [0, 0, 0]
          if (segmentCount || extentCount || rallyCount) throw new Error('MEDIA_DATA_PRESENT')

          await tx.outboxEvent.deleteMany({ where: { aggregateId: capture.id } })
          await tx.playbackWindow.deleteMany({ where: { captureSessionId: capture.id } })
          await tx.dvrProgram.deleteMany({ where: { captureSessionId: capture.id } })
          await tx.captureEpoch.deleteMany({ where: { captureSessionId: capture.id } })
          await tx.captureSession.delete({ where: { id: capture.id } })
          return {
            capture_session_id: capture.id,
            cleared: true,
            ingest_path: capture.ingestPath,
            source_kind: capture.sourceKind,
          }
        })
        if (!result) return reply.status(404).send({ code: 'NOT_FOUND' })
        const cleanupPaths = [join(importRoot, result.capture_session_id)]
        if (recordingRoot) cleanupPaths.push(join(recordingRoot, result.ingest_path))
        await Promise.all(
          cleanupPaths.map(path =>
            rm(path, { force: true, recursive: true }).catch(() => undefined),
          ),
        )
        return reply.status(200).send(result)
      } catch (error) {
        if (error instanceof Error && error.message === 'MEDIA_SOURCE_ACTIVE')
          return reply.status(409).send({ code: 'MEDIA_SOURCE_ACTIVE' })
        if (error instanceof Error && error.message === 'MEDIA_DATA_PRESENT')
          return reply.status(409).send({
            code: 'MEDIA_DATA_PRESENT',
            message: '這個來源已有媒體或標註資料，為避免誤刪只能保留；請用重新載入或刪除整個場次。',
          })
        throw error
      }
    })

    app.post('/api/v1/media-sources/rtmp', async (request, reply) => {
      const identity = operator(await dependencies.authenticate(request))
      if (!identity) return reply.status(401).send({ code: 'UNAUTHENTICATED' })
      const parsed = RtmpRequest.safeParse(request.body)
      if (!parsed.success)
        return reply.status(400).send({ code: 'BAD_USER_INPUT', message: 'RTMP 來源資料不完整' })

      const streamKey = rtmpStreamKey()
      const capture = await createCapture(dependencies.database, identity, {
        ingestPath: streamKey,
        matchId: parsed.data.match_id,
        sourceConfigSecretRef: `media-source://rtmp/${streamKey}`,
        sourceKind: 'rtmp',
        sourceLabel: parsed.data.source_label ?? 'RTMP 直播',
      })
      try {
        await scheduleWork(dependencies.database, {
          captureSessionId: capture.id,
          sourceKind: 'rtmp',
        })
      } catch (error) {
        await failCapture(
          dependencies.database,
          capture.id,
          error instanceof Error ? error.message : 'MEDIA_SOURCE_START_FAILED',
        ).catch(() => undefined)
        return reply.status(502).send({
          code: 'SOURCE_START_FAILED',
          message: 'RTMP 來源已建立，但媒體處理程序無法啟動；場次已保留，可稍後重試。',
        })
      }
      return reply
        .header('cache-control', 'no-store')
        .status(202)
        .send({
          ...capturePayload(capture),
          rtmp: rtmpCredentials(streamKey, publicRtmpBase),
        })
    })

    app.get('/api/v1/media-sources/rtmp/:capture_session_id', async (request, reply) => {
      const identity = operator(await dependencies.authenticate(request))
      if (!identity) return reply.status(401).send({ code: 'UNAUTHENTICATED' })
      const params = z
        .object({ capture_session_id: z.string().regex(UUID) })
        .safeParse(request.params)
      if (!params.success) return reply.status(404).send({ code: 'NOT_FOUND' })
      const capture = await dependencies.database.captureSession.findFirst({
        select: { id: true, ingestPath: true },
        where: {
          id: params.data.capture_session_id,
          sourceKind: 'rtmp',
          match: {
            deletionRequestedAt: null,
            ...(identity.role === UserRole.ADMIN
              ? {}
              : {
                  members: {
                    some: {
                      userId: identity.id,
                      role: { in: [UserRole.ADMIN, UserRole.OPERATOR] },
                    },
                  },
                }),
          },
        },
      })
      if (!capture) return reply.status(404).send({ code: 'NOT_FOUND' })
      return reply.header('cache-control', 'no-store').send({
        capture_session_id: capture.id,
        rtmp: rtmpCredentials(capture.ingestPath, publicRtmpBase),
      })
    })

    app.post('/api/v1/media-sources/upload', async (request, reply) => {
      const identity = operator(await dependencies.authenticate(request))
      if (!identity) return reply.status(401).send({ code: 'UNAUTHENTICATED' })
      const uploadId = randomUUID()
      const stagingDirectory = join(importRoot, '.staging', uploadId)
      const stagingFile = join(stagingDirectory, 'source.mp4.part')
      await mkdir(stagingDirectory, { recursive: true })
      let matchId = ''
      let sourceLabel = ''
      let originalFilename = ''
      let receivedFile = false
      try {
        for await (const part of request.parts()) {
          if (part.type === 'field') {
            const value = typeof part.value === 'string' ? part.value.trim() : ''
            if (part.fieldname === 'match_id') matchId = value
            else if (part.fieldname === 'source_label') sourceLabel = value
            continue
          }
          if (part.fieldname !== 'file' || receivedFile) {
            part.file.resume()
            continue
          }
          originalFilename = part.filename
          if (
            extname(part.filename).toLowerCase() !== '.mp4' ||
            !['video/mp4', 'application/octet-stream'].includes(part.mimetype)
          ) {
            part.file.resume()
            return reply
              .status(415)
              .send({ code: 'UNSUPPORTED_MEDIA_TYPE', message: '目前僅支援 MP4 影片。' })
          }
          receivedFile = true
          await pipeline(part.file, createWriteStream(stagingFile, { flags: 'wx' }))
          if (part.file.truncated)
            return reply
              .status(413)
              .send({ code: 'FILE_TOO_LARGE', message: '影片超過系統允許的上傳大小。' })
        }
        if (!UUID.test(matchId) || !receivedFile)
          return reply
            .status(400)
            .send({ code: 'BAD_USER_INPUT', message: '請選擇場次與 MP4 影片。' })
        if (sourceLabel.length > 120)
          return reply.status(400).send({ code: 'BAD_USER_INPUT', message: '來源名稱過長。' })

        const path = ingestPath(matchId, 'local_mp4')
        const capture = await createCapture(dependencies.database, identity, {
          ingestPath: path,
          matchId,
          sourceConfigSecretRef: `media-source://upload/${uploadId}`,
          sourceKind: 'local_mp4',
          sourceLabel: sourceLabel || originalFilename,
        })
        const captureDirectory = join(importRoot, capture.id)
        const importPath = join(captureDirectory, 'source.mp4')
        // The gateway sees the same volume through its own mount point. Send a
        // root-relative key instead of leaking this container's absolute path.
        const importKey = `${capture.id}/source.mp4`
        await mkdir(captureDirectory, { recursive: true })
        await rename(stagingFile, importPath)
        try {
          await scheduleWork(dependencies.database, {
            captureSessionId: capture.id,
            importKey,
            sourceKind: 'local_mp4',
          })
        } catch (error) {
          await failCapture(
            dependencies.database,
            capture.id,
            error instanceof Error ? error.message : 'MEDIA_SOURCE_START_FAILED',
          ).catch(() => undefined)
          await rm(captureDirectory, { force: true, recursive: true })
          return reply.status(502).send({
            code: 'SOURCE_START_FAILED',
            message: '影片已接收，但媒體處理程序無法啟動；場次已保留，可稍後重試。',
          })
        }
        return reply.status(202).send(capturePayload(capture))
      } finally {
        await rm(stagingDirectory, { force: true, recursive: true }).catch(() => undefined)
      }
    })
  }
}
