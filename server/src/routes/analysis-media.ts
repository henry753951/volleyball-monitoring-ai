import { db } from '@volleyball-monitoring/db'
import { ArtifactState, JobStatus, UserRole } from '@volleyball-monitoring/db/client'
import type { FastifyPluginAsync } from 'fastify'
import { Client } from 'minio'
import { authenticateDevelopmentAnnotationRequest } from '../realtime/auth.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
function client() { const endpoint = new URL(process.env.MINIO_ENDPOINT ?? 'http://minio:9000'); const accessKey = process.env.MINIO_ACCESS_KEY; const secretKey = process.env.MINIO_SECRET_KEY; if (!accessKey || !secretKey) throw new Error('MinIO credentials are required'); return new Client({ endPoint: endpoint.hostname, port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)), useSSL: endpoint.protocol === 'https:', accessKey, secretKey, pathStyle: true }) }

export const analysisMediaRoutes: FastifyPluginAsync = async (app) => {
  const storage = client()
  app.get<{ Params: { rallyId: string } }>('/api/v1/analysis/rallies/:rallyId/clip', async (request, reply) => {
    if (!UUID.test(request.params.rallyId)) return reply.status(404).send({ code: 'NOT_FOUND' })
    const identity = await authenticateDevelopmentAnnotationRequest(request, db)
    if (!identity) return reply.status(401).send({ code: 'UNAUTHENTICATED' })
    const clip = await db.clipJob.findFirst({ where: { status: JobStatus.COMPLETED, submission: { rally: { id: request.params.rallyId, voidedAt: null, ...(identity.role === UserRole.ADMIN ? {} : { match: { members: { some: { userId: identity.userId } } } }) } }, clipAsset: { state: ArtifactState.READY, deletedAt: null } }, orderBy: { completedAt: 'desc' }, select: { clipAsset: { select: { bucket: true, objectKey: true, contentType: true, byteLength: true, sha256: true } } } })
    const asset = clip?.clipAsset
    if (!asset || asset.byteLength === null || asset.sha256 === null || asset.byteLength > BigInt(Number.MAX_SAFE_INTEGER)) return reply.status(404).send({ code: 'NOT_FOUND' })
    const total = Number(asset.byteLength)
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
    reply.header('Accept-Ranges', 'bytes').header('ETag', `"${asset.sha256}"`).type(asset.contentType)
    if (range) {
      const start = Number(range[1]); const requestedEnd = range[2] ? Number(range[2]) : total - 1; const end = Math.min(requestedEnd, total - 1)
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= total) return reply.status(416).header('Content-Range', `bytes */${total}`).send()
      reply.status(206).header('Content-Range', `bytes ${start}-${end}/${total}`).header('Content-Length', String(end - start + 1))
      return reply.send(await storage.getPartialObject(asset.bucket, asset.objectKey, start, end - start + 1))
    }
    reply.header('Content-Length', String(total))
    return reply.send(await storage.getObject(asset.bucket, asset.objectKey))
  })
}
