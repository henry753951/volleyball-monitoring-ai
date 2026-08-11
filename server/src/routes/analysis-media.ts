import { db } from '@volleyball-monitoring/db'
import { ArtifactState, JobStatus, UserRole } from '@volleyball-monitoring/db/client'
import type { FastifyPluginAsync } from 'fastify'
import archiver from 'archiver'
import { Client } from 'minio'
import { extname } from 'node:path'
import { readClipFrameTimeline } from '../media/clip-timing-coverage.js'
import { resolveOverlayAnalysisId, resolveOverlaySourceAnalysisRunId } from '../media/overlay-analysis-id.js'
import type { MediaObjectReader } from '../media/playback-domain.js'
import { authenticateDevelopmentAnnotationRequest } from '../realtime/auth.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
function client() { const endpoint = new URL(process.env.MINIO_ENDPOINT ?? 'http://minio:9000'); const accessKey = process.env.MINIO_ACCESS_KEY; const secretKey = process.env.MINIO_SECRET_KEY; if (!accessKey || !secretKey) throw new Error('MinIO credentials are required'); return new Client({ endPoint: endpoint.hostname, port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)), useSSL: endpoint.protocol === 'https:', accessKey, secretKey, pathStyle: true }) }

export function analysisMediaRoutesWithDependencies(dependencies: { timingManifestReader: MediaObjectReader }): FastifyPluginAsync {
  return async (app) => {
  const storage = client()
  app.get<{ Params: { rallyId: string }; Querystring: { clipJobId?: string } }>('/api/v1/analysis/rallies/:rallyId/clip', async (request, reply) => {
    if (!UUID.test(request.params.rallyId)) return reply.status(404).send({ code: 'NOT_FOUND' })
    if (request.query.clipJobId && !UUID.test(request.query.clipJobId)) return reply.status(404).send({ code: 'NOT_FOUND' })
    const identity = await authenticateDevelopmentAnnotationRequest(request, db)
    if (!identity) return reply.status(401).send({ code: 'UNAUTHENTICATED' })
    const clip = await db.clipJob.findFirst({ where: { ...(request.query.clipJobId ? { id: request.query.clipJobId } : {}), status: JobStatus.COMPLETED, submission: { rally: { id: request.params.rallyId, voidedAt: null, ...(identity.role === UserRole.ADMIN ? {} : { match: { members: { some: { userId: identity.userId } } } }) } }, clipAsset: { state: ArtifactState.READY, deletedAt: null } }, orderBy: { completedAt: 'desc' }, select: { clipAsset: { select: { bucket: true, objectKey: true, contentType: true, byteLength: true, sha256: true } } } })
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

  app.get<{ Params: { analysisRunId: string } }>('/api/v1/analysis-runs/:analysisRunId/dataset.zip', async (request, reply) => {
    if (!UUID.test(request.params.analysisRunId)) return reply.status(404).send({ code: 'NOT_FOUND' })
    const identity = await authenticateDevelopmentAnnotationRequest(request, db)
    if (!identity) return reply.status(401).send({ code: 'UNAUTHENTICATED' })
    const run = await db.analysisRun.findFirst({
      where: {
        id: request.params.analysisRunId,
        status: JobStatus.COMPLETED,
        submission: { rally: { voidedAt: null, ...(identity.role === UserRole.ADMIN ? {} : { match: { members: { some: { userId: identity.userId } } } }) } },
      },
      include: {
        actionCorrections: true,
        artifacts: { include: { asset: true } },
        ballCorrections: true,
        contactActorCorrections: true,
        contactTimeCorrections: true,
        playerBBoxCorrections: true,
        rawAnalysisAsset: true,
        rawOverlayAsset: true,
        aiJob: { include: { clipJob: { include: { clipAsset: true, timingManifest: true } } } },
        submission: { select: { rally: { select: { id: true, match: { select: { title: true } } } } } },
      },
    })
    if (!run?.aiJob.clipJob?.clipAsset) return reply.status(404).send({ code: 'NOT_FOUND' })

    const json = (value: unknown) => Buffer.from(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2))
    const assets = [
      { name: 'video/clip.mp4', asset: run.aiJob.clipJob.clipAsset, store: true },
      ...(run.rawAnalysisAsset ? [{ name: 'analysis/result.json', asset: run.rawAnalysisAsset, store: false }] : []),
      ...(run.rawOverlayAsset ? [{ name: 'analysis/overlay.flatbuffers', asset: run.rawOverlayAsset, store: true }] : []),
      ...(run.aiJob.clipJob.timingManifest ? [{ name: 'analysis/timing-manifest.json', asset: run.aiJob.clipJob.timingManifest, store: false }] : []),
      ...run.artifacts.map((entry, index) => ({ name: `analysis/artifacts/${String(entry.kind).toLowerCase()}-${index + 1}${extname(entry.asset.objectKey)}`, asset: entry.asset, store: true })),
    ].filter(entry => entry.asset.state === ArtifactState.READY && entry.asset.deletedAt === null)
    const seenAssets = new Set<string>()
    const uniqueAssets = assets.filter(entry => seenAssets.has(entry.asset.id) ? false : (seenAssets.add(entry.asset.id), true))
    const manifest = {
      schema_version: '1.0.0',
      analysis_run_id: run.id,
      analysis_id: run.analysisId,
      analysis_version: run.analysisVersion,
      producer: { name: run.producerName, build_id: run.producerBuildId, sdk_version: run.producerSdkVersion },
      input_clip_sha256: run.inputClipSha256,
      review_revision: run.reviewRevision.toString(),
      files: uniqueAssets.map(entry => ({ path: entry.name, byte_length: entry.asset.byteLength?.toString() ?? null, sha256: entry.asset.sha256, content_type: entry.asset.contentType })),
    }
    const review = {
      revision: run.reviewRevision.toString(),
      ball_corrections: run.ballCorrections,
      action_corrections: run.actionCorrections,
      player_bbox_corrections: run.playerBBoxCorrections,
      contact_actor_corrections: run.contactActorCorrections,
      contact_time_corrections: run.contactTimeCorrections,
    }

    const archive = archiver('zip', { zlib: { level: 6 } })
    archive.on('warning', error => request.log.warn({ error, analysisRunId: run.id }, 'dataset zip warning'))
    archive.on('error', error => request.log.error({ error, analysisRunId: run.id }, 'dataset zip failed'))
    archive.append(json(manifest), { name: 'manifest.json' })
    archive.append(json(review), { name: 'analysis/review-corrections.json' })
    for (const entry of uniqueAssets) {
      archive.append(await storage.getObject(entry.asset.bucket, entry.asset.objectKey), { name: entry.name, store: entry.store })
    }
    const baseName = `${run.submission.rally.match.title}-${run.submission.rally.id}`.replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 120)
    reply
      .header('Cache-Control', 'private, no-store')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${baseName}-dataset.zip`)}`)
      .type('application/zip')
    void archive.finalize()
    return reply.send(archive)
  })

  app.get<{ Params: { analysisRunId: string } }>('/api/v1/analysis-runs/:analysisRunId/overlay-manifest', async (request, reply) => {
    if (!UUID.test(request.params.analysisRunId)) return reply.status(404).send({ code: 'NOT_FOUND' })
    const identity = await authenticateDevelopmentAnnotationRequest(request, db)
    if (!identity) return reply.status(401).send({ code: 'UNAUTHENTICATED' })
    const manifest = await db.overlayManifest.findFirst({
      where: { analysisRunId: request.params.analysisRunId, analysisRun: { status: JobStatus.COMPLETED, submission: { rally: { voidedAt: null, ...(identity.role === UserRole.ADMIN ? {} : { match: { members: { some: { userId: identity.userId } } } }) } } } },
      include: {
        chunks: { where: { asset: { state: ArtifactState.READY, deletedAt: null } }, include: { asset: { select: { contentType: true } } }, orderBy: { chunkIndex: 'asc' } },
        analysisRun: {
          select: {
            analysisId: true,
            aiJob: {
              select: {
                requestPayload: true,
                clipJob: {
                  select: {
                    id: true,
                    timingManifest: { select: { bucket: true, objectKey: true, contentType: true, byteLength: true, sha256: true, internalSchemaVersion: true } },
                  },
                },
              },
            },
          },
        },
      },
    })
    if (!manifest) return reply.status(404).send({ code: 'NOT_FOUND' })
    const clipJob = manifest.analysisRun.aiJob.clipJob
    let frameTiming: {
      capture_time_us: string[]
      capture_end_time_us: string
      clip_time_us: string[]
      clip_end_time_us: string
    } | null = null
    if (clipJob.timingManifest) {
      try {
        const timeline = await readClipFrameTimeline(dependencies.timingManifestReader, clipJob.timingManifest, clipJob.id)
        if (BigInt(timeline.clipTimeUs.length) !== manifest.totalFrames) throw new Error('overlay and timing manifest frame counts differ')
        frameTiming = {
          capture_time_us: timeline.captureTimeUs.map(value => value.toString()),
          capture_end_time_us: timeline.captureEndUs.toString(),
          clip_time_us: timeline.clipTimeUs.map(value => value.toString()),
          clip_end_time_us: timeline.clipEndUs.toString(),
        }
      }
      catch (error) {
        request.log.warn({ error, analysisRunId: manifest.analysisRunId }, 'Exact overlay frame timeline is unavailable')
      }
    }
    const requestPayload = manifest.analysisRun.aiJob.requestPayload
    const directEmbeddedAnalysisId = resolveOverlayAnalysisId(manifest.analysisRun.analysisId, requestPayload)
    const sourceAnalysisRunId = resolveOverlaySourceAnalysisRunId(requestPayload)
    const legacySourceAnalysis = directEmbeddedAnalysisId === manifest.analysisRun.analysisId && sourceAnalysisRunId
      ? await db.analysisRun.findUnique({ where: { id: sourceAnalysisRunId }, select: { analysisId: true } })
      : null
    const embeddedAnalysisId = legacySourceAnalysis?.analysisId ?? directEmbeddedAnalysisId
    return reply.header('Cache-Control', 'private, no-store').send({
      schema_version: manifest.schemaVersion,
      analysis_id: embeddedAnalysisId,
      overlay_version: manifest.overlayVersion,
      video: { width: manifest.videoWidth, height: manifest.videoHeight, fps: { num: manifest.fpsNum, den: manifest.fpsDen }, total_frames: manifest.totalFrames.toString() },
      frame_timing: frameTiming,
      chunk_frame_count: manifest.chunkFrameCount,
      chunks: manifest.chunks.map(chunk => ({ chunk_index: chunk.chunkIndex, start_frame_index: chunk.startFrameIndex.toString(), frame_count: chunk.frameCount, url: `/api/v1/analysis-runs/${manifest.analysisRunId}/overlay-chunks/${chunk.chunkIndex}`, byte_length: chunk.byteLength.toString(), sha256: chunk.sha256 })),
      action_taxonomy: manifest.actionTaxonomy,
    })
  })

  app.get<{ Params: { analysisRunId: string; chunkIndex: string } }>('/api/v1/analysis-runs/:analysisRunId/overlay-chunks/:chunkIndex', async (request, reply) => {
    if (!UUID.test(request.params.analysisRunId) || !/^(0|[1-9][0-9]*)$/.test(request.params.chunkIndex)) return reply.status(404).send({ code: 'NOT_FOUND' })
    const chunkIndex = Number(request.params.chunkIndex)
    if (!Number.isSafeInteger(chunkIndex)) return reply.status(404).send({ code: 'NOT_FOUND' })
    const identity = await authenticateDevelopmentAnnotationRequest(request, db)
    if (!identity) return reply.status(401).send({ code: 'UNAUTHENTICATED' })
    const chunk = await db.overlayChunk.findFirst({
      where: { analysisRunId: request.params.analysisRunId, chunkIndex, manifest: { analysisRun: { status: JobStatus.COMPLETED, submission: { rally: { voidedAt: null, ...(identity.role === UserRole.ADMIN ? {} : { match: { members: { some: { userId: identity.userId } } } }) } } } }, asset: { state: ArtifactState.READY, deletedAt: null } },
      include: { asset: { select: { bucket: true, objectKey: true, contentType: true } } },
    })
    if (!chunk) return reply.status(404).send({ code: 'NOT_FOUND' })
    return reply.header('Cache-Control', 'private, max-age=300').header('Content-Length', chunk.byteLength.toString()).header('ETag', `"${chunk.sha256}"`).type(chunk.asset.contentType).send(await storage.getObject(chunk.asset.bucket, chunk.asset.objectKey))
  })
  }
}
