import type { FastifyPluginAsync } from 'fastify'
import { randomUUID } from 'node:crypto'
import { db } from '@volleyball-monitoring/db'

export interface MediaPlaybackDeps { now?: () => Date; maxBackUs?: bigint; maxForwardUs?: bigint; resolveSample?: (input: { targetUs: bigint; segments: { captureStartUs: bigint; captureEndUs: bigint }[] }) => Promise<{ captureUs: bigint; playerUs: bigint }> }
const error = (reply: any, status: number, code: string, message: string) => reply.code(status).send({ schema_version: '1.0.0', code, message, request_id: randomUUID() })
const auth = (request: any) => { const id = request.headers['x-dev-user-id']; const role = request.headers['x-dev-role']; return id ? { id, role } : null }

export const mediaPlaybackRoutes = (deps: MediaPlaybackDeps = {}): FastifyPluginAsync => async (app) => {
  const now = deps.now ?? (() => new Date())
  app.post('/api/v1/media/playback-windows', async (request: any, reply) => {
    const identity = auth(request); if (!identity) return error(reply, 401, 'UNAUTHENTICATED', 'Authentication required')
    const body = request.body as any; if (!body || !body.capture_session_id || !['live', 'archive'].includes(body.mode)) return error(reply, 400, 'BAD_REQUEST', 'Invalid playback window request')
    const session = await db.captureSession.findFirst({ where: { id: body.capture_session_id, match: { members: { some: { userId: identity.id } } } } }); if (!session) return error(reply, 404, 'NOT_FOUND', 'Capture session not found')
    const program = await db.dvrProgram.findFirst({ where: { captureSessionId: session.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }); if (!program) return error(reply, 409, 'MEDIA_NOT_READY', 'Media is not ready')
    const target = body.mode === 'live' ? program.liveEdgeUs : BigInt(body.target_capture_time_us); const segments = await db.dvrSegment.findMany({ where: { dvrProgramId: program.id, isGap: false, captureStartUs: { lte: target }, captureEndUs: { gte: target }, readyAt: { not: null }, initAsset: { state: 'READY', internalSchemaVersion: { not: null } }, mediaAsset: { state: 'READY', internalSchemaVersion: { not: null } }, sampleIndexAsset: { state: 'READY', internalSchemaVersion: { not: null } } }, orderBy: { captureStartUs: 'asc' } }); if (!segments.length) return error(reply, 422, 'CAPTURE_GAP', 'Target is unavailable')
    const first = segments[0]!; const last = segments[segments.length - 1]!; const origin = first.captureStartUs; const player = (deps.resolveSample ? await deps.resolveSample({ targetUs: target, segments }) : null); if (!player) return error(reply, 409, 'MEDIA_NOT_READY', 'Sample index resolver unavailable')
    const expiresAt = new Date(now().getTime() + 300_000); const windowId = randomUUID(); await db.$transaction(async (tx) => { await tx.playbackWindow.create({ data: { id: windowId, captureSessionId: session.id, dvrProgramId: program.id, createdByUserId: identity.id, mode: body.mode === 'live' ? 'LIVE' : 'ARCHIVE', mappingVersion: 1, timelineVersion: program.playlistRevision, captureStartUs: first.captureStartUs, captureEndUs: last.captureEndUs, presentationOriginCaptureUs: origin, targetPlayerMediaTimeUs: player.playerUs, expiresAt, segments: { create: segments.map((s, i) => ({ dvrSegmentId: s.id, sequenceIndex: i })) } } }) })
    return reply.send({ schema_version: '1.0.0', playback_window_id: windowId, capture_session_id: session.id, mode: body.mode, mapping_version: 1, timeline_capture_start_us: first.captureStartUs.toString(), timeline_capture_end_us: last.captureEndUs.toString(), window_capture_start_us: first.captureStartUs.toString(), window_capture_end_us: last.captureEndUs.toString(), presentation_origin_capture_us: origin.toString(), target_player_media_time_us: player.playerUs.toString(), manifest_url: `/api/v1/media/playback-windows/${windowId}/manifest.m3u8`, expires_at: expiresAt.toISOString(), live_edge_capture_time_us: program.liveEdgeUs.toString(), has_more_before: false, has_more_after: false })
  })
}
