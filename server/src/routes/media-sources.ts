import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type { PrismaClient } from '@volleyball-monitoring/db'
import { UserRole } from '@volleyball-monitoring/db/client'
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { AnnotationIdentity } from '../services/annotation-command.js'
import {
  failCaptureStartup,
  requestCaptureCompletion,
  startCapture,
  updateCaptureSourceMetadata,
} from '../services/capture-processing.js'
import type { MediaSourceGateway } from '../media/media-source-gateway.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be'])
const YoutubeRequest = z.object({
  match_id: z.string().regex(UUID),
  source_label: z.string().trim().min(1).max(120).optional(),
  source_url: z.string().trim().url().max(2_048),
}).strict()
const SOURCE_DURATION = z.string().regex(/^[1-9][0-9]{0,18}$/).nullable()
const SOURCE_KINDS = z.enum(['local_mp4', 'youtube_live', 'youtube_vod'])
const SourceStatusRequest = z.discriminatedUnion('status', [
  z.object({
    capture_session_id: z.string().regex(UUID),
    error_code: z.string().min(1).max(120),
    status: z.literal('failed'),
  }).strict(),
  z.object({
    capture_session_id: z.string().regex(UUID),
    source_duration_us: SOURCE_DURATION,
    source_kind: SOURCE_KINDS,
    status: z.literal('classified'),
  }).strict(),
  z.object({
    capture_session_id: z.string().regex(UUID),
    expected_segment_count: z.number().int().nonnegative().max(10_000_000),
    source_duration_us: SOURCE_DURATION,
    source_kind: SOURCE_KINDS,
    status: z.literal('completed'),
  }).strict(),
])

type MediaSourceRouteDependencies = {
  authenticate(request: FastifyRequest): Promise<AnnotationIdentity | null>
  database: PrismaClient
  gateway: MediaSourceGateway
  importRoot: string
  callbackToken?: string
  startCapture?: typeof startCapture
  failCaptureStartup?: typeof failCaptureStartup
  requestCaptureCompletion?: typeof requestCaptureCompletion
  updateCaptureSourceMetadata?: typeof updateCaptureSourceMetadata
}

function operator(identity: AnnotationIdentity | null) {
  if (!identity) return null
  if (identity.role !== UserRole.ADMIN && identity.role !== UserRole.OPERATOR) return null
  return { id: identity.userId, role: identity.role }
}

function youtubeUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || !YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) throw new TypeError('請輸入有效的 YouTube 網址')
  if (!url.pathname || url.pathname === '/') throw new TypeError('請輸入完整的 YouTube 影片或直播網址')
  url.hash = ''
  return url.toString()
}

function ingestPath(matchId: string, kind: 'youtube' | 'local_mp4') {
  return `${kind}-${matchId}-${randomUUID()}`
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
  const createCapture = dependencies.startCapture ?? startCapture
  const failCapture = dependencies.failCaptureStartup ?? failCaptureStartup
  const completeCapture = dependencies.requestCaptureCompletion ?? requestCaptureCompletion
  const updateSourceMetadata = dependencies.updateCaptureSourceMetadata ?? updateCaptureSourceMetadata
  const callbackToken = dependencies.callbackToken?.trim() ?? ''
  const validCallbackToken = (authorization: string | undefined) => {
    if (callbackToken.length < 32 || !authorization?.startsWith('Bearer ')) return false
    const expected = createHash('sha256').update(callbackToken).digest()
    const actual = createHash('sha256').update(authorization.slice(7)).digest()
    return timingSafeEqual(expected, actual)
  }
  return async (app) => {
    app.post('/internal/media-sources/status', async (request, reply) => {
      if (!validCallbackToken(request.headers.authorization)) return reply.status(401).send({ code: 'UNAUTHENTICATED' })
      const parsed = SourceStatusRequest.safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ code: 'BAD_USER_INPUT' })
      if (parsed.data.status === 'failed') {
        await failCapture(dependencies.database, parsed.data.capture_session_id, parsed.data.error_code)
      }
      else if (parsed.data.status === 'classified') {
        await updateSourceMetadata(dependencies.database, parsed.data.capture_session_id, {
          sourceDurationUs: parsed.data.source_duration_us === null
            ? null
            : BigInt(parsed.data.source_duration_us),
          sourceKind: parsed.data.source_kind,
        })
      }
      else {
        await completeCapture(dependencies.database, parsed.data.capture_session_id, {
          expectedSegments: parsed.data.expected_segment_count,
          sourceDurationUs: parsed.data.source_duration_us === null
            ? null
            : BigInt(parsed.data.source_duration_us),
          sourceKind: parsed.data.source_kind,
        })
      }
      return reply.status(204).send()
    })

    app.post('/api/v1/media-sources/youtube', async (request, reply) => {
      const identity = operator(await dependencies.authenticate(request))
      if (!identity) return reply.status(401).send({ code: 'UNAUTHENTICATED' })
      const parsed = YoutubeRequest.safeParse(request.body)
      if (!parsed.success) return reply.status(400).send({ code: 'BAD_USER_INPUT', message: 'YouTube 來源資料不完整' })
      let sourceUrl: string
      try { sourceUrl = youtubeUrl(parsed.data.source_url) }
      catch (error) { return reply.status(400).send({ code: 'BAD_USER_INPUT', message: error instanceof Error ? error.message : 'YouTube 網址無效' }) }

      const path = ingestPath(parsed.data.match_id, 'youtube')
      const capture = await createCapture(dependencies.database, identity, {
        ingestPath: path,
        matchId: parsed.data.match_id,
        sourceConfigSecretRef: `media-source://youtube/${basename(path)}`,
        sourceKind: 'youtube',
        sourceLabel: parsed.data.source_label ?? 'YouTube',
      })
      try {
        await dependencies.gateway.start({ captureSessionId: capture.id, ingestPath: path, sourceKind: 'youtube', sourceUrl })
      }
      catch (error) {
        await failCapture(dependencies.database, capture.id, error instanceof Error ? error.message : 'MEDIA_SOURCE_START_FAILED').catch(() => undefined)
        return reply.status(502).send({ code: 'SOURCE_START_FAILED', message: '無法啟動 YouTube 來源，場次已保留，可稍後重試。' })
      }
      return reply.status(202).send(capturePayload(capture))
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
          if (extname(part.filename).toLowerCase() !== '.mp4' || !['video/mp4', 'application/octet-stream'].includes(part.mimetype)) {
            part.file.resume()
            return reply.status(415).send({ code: 'UNSUPPORTED_MEDIA_TYPE', message: '目前僅支援 MP4 影片。' })
          }
          receivedFile = true
          await pipeline(part.file, createWriteStream(stagingFile, { flags: 'wx' }))
          if (part.file.truncated) return reply.status(413).send({ code: 'FILE_TOO_LARGE', message: '影片超過系統允許的上傳大小。' })
        }
        if (!UUID.test(matchId) || !receivedFile) return reply.status(400).send({ code: 'BAD_USER_INPUT', message: '請選擇場次與 MP4 影片。' })
        if (sourceLabel.length > 120) return reply.status(400).send({ code: 'BAD_USER_INPUT', message: '來源名稱過長。' })

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
          await dependencies.gateway.start({ captureSessionId: capture.id, importPath: importKey, ingestPath: path, sourceKind: 'local_mp4' })
        }
        catch (error) {
          await failCapture(dependencies.database, capture.id, error instanceof Error ? error.message : 'MEDIA_SOURCE_START_FAILED').catch(() => undefined)
          await rm(captureDirectory, { force: true, recursive: true })
          return reply.status(502).send({ code: 'SOURCE_START_FAILED', message: '影片已接收，但媒體處理程序無法啟動；場次已保留，可稍後重試。' })
        }
        return reply.status(202).send(capturePayload(capture))
      }
      finally {
        await rm(stagingDirectory, { force: true, recursive: true }).catch(() => undefined)
      }
    })
  }
}
