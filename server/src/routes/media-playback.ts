import { randomUUID } from 'node:crypto'
import {
  parsePlaybackWindowExtendRequest,
  parsePlaybackWindowRequest,
  type PlaybackWindowExtendRequest,
  type PlaybackWindowRequest,
} from '@volleyball-monitoring/contracts'
import { db } from '@volleyball-monitoring/db'
import { UserRole } from '@volleyball-monitoring/db/client'
import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify'
import {
  MEDIA_INTERNAL_SCHEMA_VERSION,
  MediaHttpError,
  assertRollingPlaybackSelection,
  buildPlaybackDescriptor,
  buildReadyPlaybackRuns,
  formatManifest,
  mediaErrorEnvelope,
  parsePlaybackResourceToken,
  presentationOriginForSnap,
  selectPlaybackWindow,
  validSha256,
  type PlaybackSegmentCandidate,
  type PlaybackWindowLimits,
  type MediaAssetKind,
  type MediaObjectReader,
  type SampleSnapResult,
} from '../media/playback-domain.js'

export { formatManifest } from '../media/playback-domain.js'

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const USER_ROLES = new Set<UserRole>(Object.values(UserRole))
const DEFAULT_LIMITS: PlaybackWindowLimits = {
  defaultBackUs: 30_000_000n,
  defaultForwardUs: 10_000_000n,
  maxBackUs: 300_000_000n,
  maxForwardUs: 300_000_000n,
}

export interface MediaIdentity {
  id: string
  role: UserRole
}

export interface MediaPlaybackDeps {
  now?: () => Date
  windowTtlMs?: number
  limits?: Partial<PlaybackWindowLimits>
  authenticate?: (request: FastifyRequest) => Promise<MediaIdentity | null>
  resolveSample?: (input: {
    captureSessionId: string
    dvrProgramId: string
    targetUs: bigint
    segments: readonly {
      id: string
      captureStartUs: bigint
      captureEndUs: bigint
      discontinuity: number
      sampleIndexLocation: {
        bucket: string
        key: string
      }
    }[]
  }) => Promise<SampleSnapResult>
  objectReader?: MediaObjectReader
}

interface WindowParams {
  windowId: string
}

interface ResourceParams extends WindowParams {
  segmentId: string
}

function headerValue(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name]
  return typeof value === 'string' ? value : null
}

async function defaultDevelopmentIdentity(
  request: FastifyRequest,
): Promise<MediaIdentity | null> {
  if (
    process.env.DEV_AUTH_ENABLED !== 'true'
    || process.env.NODE_ENV === 'production'
  ) {
    return null
  }
  const id = headerValue(request, 'x-dev-user-id') ?? process.env.DEV_USER_ID ?? null
  const roleValue = headerValue(request, 'x-dev-role') ?? process.env.DEV_USER_ROLE ?? null
  if (id === null && roleValue === null) return null
  if (id === null || !UUID.test(id) || roleValue === null) {
    throw new MediaHttpError(401, 'UNAUTHENTICATED', 'Invalid development identity')
  }
  if (!USER_ROLES.has(roleValue as UserRole)) {
    throw new MediaHttpError(401, 'UNAUTHENTICATED', 'Invalid development role')
  }
  await db.user.upsert({
    where: { id },
    update: {},
    create: {
      displayName: headerValue(request, 'x-dev-display-name')?.trim()
        || process.env.DEV_USER_DISPLAY_NAME?.trim()
        || 'Development User',
      email: `${id}@dev.volleyball.local`,
      id,
    },
  })
  return { id, role: roleValue as UserRole }
}

function requestId(request: FastifyRequest): string {
  const value = String(request.id)
  return value.length > 0 && value.length <= 128 ? value : randomUUID()
}

function sendMediaError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
) {
  if (error instanceof MediaHttpError) {
    return reply
      .code(error.status)
      .send(mediaErrorEnvelope(error, requestId(request)))
  }
  request.log.error({ err: error }, 'media playback request failed')
  return reply.code(500).send(mediaErrorEnvelope(
    new MediaHttpError(500, 'MEDIA_NOT_READY', 'Media request failed'),
    requestId(request),
  ))
}

function parseUuid(value: string, resource: string): string {
  if (!UUID.test(value)) {
    throw new MediaHttpError(404, 'NOT_FOUND', `${resource} not found`)
  }
  return value.toLowerCase()
}

function parseWireUint(value: string | undefined): bigint | undefined {
  return value === undefined ? undefined : BigInt(value)
}

function resolvedLimits(overrides: Partial<PlaybackWindowLimits> | undefined) {
  return { ...DEFAULT_LIMITS, ...overrides }
}

function playbackWindowTtlMs(deps: MediaPlaybackDeps): number {
  const ttlMs = deps.windowTtlMs ?? 300_000
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new MediaHttpError(500, 'MEDIA_NOT_READY', 'Playback window TTL is invalid')
  }
  return ttlMs
}

interface MediaAssetMetadata {
  bucket: string
  objectKey: string
  byteLength: bigint | null
  sha256: string | null
  contentType: string
  internalSchemaVersion: string | null
  kind: string
  state: string
  readyAt: Date | null
}

type ReadyMediaAssetMetadata<Kind extends MediaAssetKind> = Omit<
  MediaAssetMetadata,
  'byteLength' | 'internalSchemaVersion' | 'kind' | 'readyAt' | 'sha256'
> & {
  byteLength: bigint
  sha256: string
  internalSchemaVersion: typeof MEDIA_INTERNAL_SCHEMA_VERSION
  kind: Kind
  readyAt: Date
}

function assetMetadataReady<Kind extends MediaAssetKind>(
  asset: MediaAssetMetadata | null,
  expectedContentType: string,
  expectedKind: Kind,
): asset is ReadyMediaAssetMetadata<Kind> {
  return asset !== null
    && asset.state === 'READY'
    && asset.readyAt !== null
    && asset.internalSchemaVersion === MEDIA_INTERNAL_SCHEMA_VERSION
    && asset.bucket.length > 0
    && asset.objectKey.length > 0
    && asset.byteLength !== null
    && asset.byteLength > 0n
    && validSha256(asset.sha256)
    && asset.contentType === expectedContentType
    && asset.kind === expectedKind
}

async function loadProgramSegments(dvrProgramId: string) {
  return db.dvrSegment.findMany({
    include: {
      initAsset: true,
      mediaAsset: true,
      sampleIndexAsset: true,
    },
    orderBy: [
      { captureStartUs: 'asc' },
      { sequenceNumber: 'asc' },
      { id: 'asc' },
    ],
    where: { dvrProgramId },
  })
}

type ProgramSegmentRow = Awaited<ReturnType<typeof loadProgramSegments>>[number]

function programSegmentReady(segment: ProgramSegmentRow): boolean {
  return segment.readyAt !== null
    && assetMetadataReady(segment.initAsset, 'video/mp4', 'DVR_INIT')
    && assetMetadataReady(segment.mediaAsset, 'video/mp4', 'DVR_SEGMENT')
    && assetMetadataReady(segment.sampleIndexAsset, 'application/json', 'SAMPLE_INDEX')
}

function toCandidate(segment: ProgramSegmentRow): PlaybackSegmentCandidate {
  return {
    captureEndUs: segment.captureEndUs,
    captureStartUs: segment.captureStartUs,
    discontinuity: segment.discontinuitySequence,
    durationUs: segment.durationUs,
    id: segment.id,
    initAssetId: segment.initAssetId,
    isGap: segment.isGap,
    mediaAssetId: segment.mediaAssetId,
    ready: programSegmentReady(segment),
  }
}

async function visibleCaptureSession(id: string, identity: MediaIdentity) {
  return db.captureSession.findFirst({
    where: {
      id,
      ...(identity.role === UserRole.ADMIN
        ? {}
        : { match: { members: { some: { userId: identity.id } } } }),
    },
  })
}

async function newestProgram(captureSessionId: string) {
  return db.dvrProgram.findFirst({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    where: { captureSessionId },
  })
}

function visibleWindowWhere(id: string, identity: MediaIdentity) {
  return {
    id,
    ...(identity.role === UserRole.ADMIN
      ? {}
      : {
          captureSession: {
            match: { members: { some: { userId: identity.id } } },
          },
        }),
  }
}

async function visibleWindow(id: string, identity: MediaIdentity) {
  return db.playbackWindow.findFirst({
    include: { dvrProgram: true },
    where: visibleWindowWhere(id, identity),
  })
}

async function visibleWindowWithSegments(id: string, identity: MediaIdentity) {
  return db.playbackWindow.findFirst({
    include: {
      dvrProgram: true,
      segments: {
        include: {
          dvrSegment: {
            include: {
              captureEpoch: { select: { sequenceIndex: true } },
              initAsset: true,
              mediaAsset: true,
            },
          },
        },
        orderBy: { sequenceIndex: 'asc' },
      },
    },
    where: visibleWindowWhere(id, identity),
  })
}

type VisibleWindow = NonNullable<Awaited<ReturnType<typeof visibleWindow>>>
type VisibleWindowWithSegments = NonNullable<
  Awaited<ReturnType<typeof visibleWindowWithSegments>>
>

function assertWindowActive(window: { expiresAt: Date }, now: Date): void {
  if (window.expiresAt <= now) {
    throw new MediaHttpError(410, 'WINDOW_EXPIRED', 'Playback window expired')
  }
}

async function authenticate(
  request: FastifyRequest,
  dependency: MediaPlaybackDeps['authenticate'],
): Promise<MediaIdentity> {
  const identity = await (dependency ?? defaultDevelopmentIdentity)(request)
  if (!identity) {
    throw new MediaHttpError(401, 'UNAUTHENTICATED', 'Authentication required')
  }
  if (!UUID.test(identity.id) || !USER_ROLES.has(identity.role)) {
    throw new MediaHttpError(401, 'UNAUTHENTICATED', 'Invalid identity')
  }
  return identity
}

function timelineBounds(candidates: readonly PlaybackSegmentCandidate[]) {
  const runs = buildReadyPlaybackRuns(candidates)
  if (runs.length === 0) {
    throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'No playable media is ready')
  }
  return { startUs: runs[0]!.startUs, endUs: runs.at(-1)!.endUs }
}

function manifestEntries(window: VisibleWindowWithSegments) {
  const mappings = window.segments
  if (mappings.length === 0) {
    throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'Playback window has no media')
  }
  let previousEndUs: bigint | null = null
  const entries = mappings.map((mapping, index) => {
    if (mapping.sequenceIndex !== index) {
      throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'Playback mapping order is invalid')
    }
    const segment = mapping.dvrSegment
    if (
      segment.isGap
      || segment.readyAt === null
      || segment.durationUs !== segment.captureEndUs - segment.captureStartUs
      || !assetMetadataReady(segment.initAsset, 'video/mp4', 'DVR_INIT')
      || !assetMetadataReady(segment.mediaAsset, 'video/mp4', 'DVR_SEGMENT')
      || segment.initAssetId === null
    ) {
      throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'Playback media is not ready')
    }
    if (
      previousEndUs !== null && previousEndUs !== segment.captureStartUs
    ) {
      throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'Playback mapping crosses a capture gap')
    }
    previousEndUs = segment.captureEndUs
    return {
      durationUs: segment.durationUs,
      // Canonical capture continuity deliberately permits a pure PTS reset
      // without opening a gap. MSE/HLS does not: fMP4 decode timestamps from a
      // new capture epoch need an EXT-X-DISCONTINUITY so hls.js assigns the
      // fragment to the next presentation range instead of overlapping the
      // preceding media. Epoch sequence is absolute, which also keeps
      // EXT-X-DISCONTINUITY-SEQUENCE stable when a rolling window drops its
      // prefix. Do not reuse the domain discontinuity counter here; that value
      // describes canonical clip/gap boundaries rather than transport PTS.
      discontinuity: segment.captureEpoch.sequenceIndex,
      id: segment.id,
      initAssetId: segment.initAssetId,
      sequenceNumber: segment.sequenceNumber,
    }
  })
  const first = mappings[0]!.dvrSegment
  const last = mappings.at(-1)!.dvrSegment
  if (
    first.captureStartUs !== window.captureStartUs
    || last.captureEndUs !== window.captureEndUs
  ) {
    throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'Playback mapping bounds are invalid')
  }
  return entries
}

async function descriptorForWindow(window: VisibleWindow) {
  const candidates = (await loadProgramSegments(window.dvrProgramId)).map(toCandidate)
  const bounds = timelineBounds(candidates)
  return buildPlaybackDescriptor({
    captureEndUs: window.captureEndUs,
    captureSessionId: window.captureSessionId,
    captureStartUs: window.captureStartUs,
    expiresAt: window.expiresAt,
    id: window.id,
    liveEdgeUs: window.dvrProgram.liveEdgeUs,
    mappingVersion: window.mappingVersion,
    mode: window.mode,
    presentationOriginCaptureUs: window.presentationOriginCaptureUs,
    targetPlayerMediaTimeUs: window.targetPlayerMediaTimeUs,
    timelineEndUs: bounds.endUs,
    timelineStartUs: bounds.startUs,
  })
}

async function createPlaybackWindow(
  request: PlaybackWindowRequest,
  identity: MediaIdentity,
  deps: MediaPlaybackDeps,
) {
  const captureSessionId = parseUuid(request.capture_session_id, 'Capture session')
  const session = await visibleCaptureSession(captureSessionId, identity)
  if (!session) {
    throw new MediaHttpError(404, 'NOT_FOUND', 'Capture session not found')
  }
  const program = await newestProgram(session.id)
  if (!program) {
    throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'Media is not ready')
  }
  const rows = await loadProgramSegments(program.id)
  const candidates = rows.map(toCandidate)
  const requestedBackUs = parseWireUint(request.requested_back_us)
  const requestedForwardUs = parseWireUint(request.requested_forward_us)
  const selection = selectPlaybackWindow({
    candidates,
    limits: resolvedLimits(deps.limits),
    liveEdgeUs: program.liveEdgeUs,
    mode: request.mode,
    ...(requestedBackUs === undefined ? {} : { requestedBackUs }),
    ...(requestedForwardUs === undefined ? {} : { requestedForwardUs }),
    requestedTargetUs: request.target_capture_time_us === undefined
      ? null
      : BigInt(request.target_capture_time_us),
  })
  if (!deps.resolveSample) {
    throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'Sample index resolver unavailable')
  }
  const selectedRows = new Map(rows.map((row) => [row.id, row]))
  let snap: SampleSnapResult
  try {
    snap = await deps.resolveSample({
      captureSessionId: session.id,
      dvrProgramId: program.id,
      segments: selection.segments.map((segment) => {
        const row = selectedRows.get(segment.id)
        if (!row || !row.sampleIndexAsset) {
          throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'Sample index is unavailable')
        }
        return {
          captureEndUs: segment.captureEndUs,
          captureStartUs: segment.captureStartUs,
          discontinuity: segment.discontinuity,
          id: segment.id,
          sampleIndexLocation: {
            bucket: row.sampleIndexAsset.bucket,
            key: row.sampleIndexAsset.objectKey,
          },
        }
      }),
      targetUs: selection.targetUs,
    })
  } catch (error) {
    if (error instanceof MediaHttpError) throw error
    throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'Sample index resolution failed')
  }
  const presentationOriginCaptureUs = presentationOriginForSnap(selection, snap)
  const expiresAt = new Date(
    (deps.now ?? (() => new Date()))().getTime() + playbackWindowTtlMs(deps),
  )
  const id = randomUUID()
  try {
    await db.$transaction((transaction) => transaction.playbackWindow.create({
      data: {
        captureEndUs: selection.windowEndUs,
        captureSessionId: session.id,
        captureStartUs: selection.windowStartUs,
        createdByUserId: identity.id,
        dvrProgramId: program.id,
        expiresAt,
        id,
        mappingVersion: 1,
        mode: request.mode === 'live' ? 'LIVE' : 'ARCHIVE',
        presentationOriginCaptureUs,
        segments: {
          create: selection.segments.map((segment, sequenceIndex) => ({
            dvrSegmentId: segment.id,
            sequenceIndex,
          })),
        },
        targetPlayerMediaTimeUs: snap.playerUs,
        timelineVersion: program.playlistRevision,
      },
    }))
  } catch {
    throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'Playback mapping could not be persisted')
  }
  return buildPlaybackDescriptor({
    captureEndUs: selection.windowEndUs,
    captureSessionId: session.id,
    captureStartUs: selection.windowStartUs,
    expiresAt,
    id,
    liveEdgeUs: program.liveEdgeUs,
    mappingVersion: 1,
    mode: request.mode === 'live' ? 'LIVE' : 'ARCHIVE',
    presentationOriginCaptureUs,
    targetPlayerMediaTimeUs: snap.playerUs,
    timelineEndUs: selection.timelineEndUs,
    timelineStartUs: selection.timelineStartUs,
  })
}

async function extendPlaybackWindow(
  windowId: string,
  request: PlaybackWindowExtendRequest,
  identity: MediaIdentity,
  deps: MediaPlaybackDeps,
) {
  const current = await visibleWindowWithSegments(windowId, identity)
  if (!current) throw new MediaHttpError(404, 'NOT_FOUND', 'Playback window not found')
  const requestNow = (deps.now ?? (() => new Date()))()
  assertWindowActive(current, requestNow)
  const ttlMs = playbackWindowTtlMs(deps)
  const renewalLeadMs = Math.min(60_000, Math.max(1_000, Math.floor(ttlMs / 2)))
  const expiresAt = current.expiresAt.getTime() <= requestNow.getTime() + renewalLeadMs
    ? new Date(requestNow.getTime() + ttlMs)
    : current.expiresAt
  if (current.segments.length === 0) {
    throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'Playback window has no media')
  }

  const targetUs = BigInt(request.target_capture_time_us)
  if (targetUs < current.captureStartUs || targetUs > current.captureEndUs) {
    throw new MediaHttpError(409, 'WINDOW_BOUNDARY', 'Continuation target is outside the current playback window')
  }
  const rows = await loadProgramSegments(current.dvrProgramId)
  const requestedForwardUs = parseWireUint(request.requested_forward_us)
  const selection = selectPlaybackWindow({
    candidates: rows.map(toCandidate),
    limits: resolvedLimits(deps.limits),
    liveEdgeUs: current.dvrProgram.liveEdgeUs,
    mode: current.mode === 'LIVE' ? 'live' : 'archive',
    requestedBackUs: targetUs - current.captureStartUs,
    ...(requestedForwardUs === undefined ? {} : { requestedForwardUs }),
    requestedTargetUs: targetUs,
  })
  const appended = assertRollingPlaybackSelection(
    current.segments.map(entry => ({
      id: entry.dvrSegment.id,
      captureStartUs: entry.dvrSegment.captureStartUs,
      captureEndUs: entry.dvrSegment.captureEndUs,
    })),
    selection.segments,
  )
  if (!appended) {
    if (expiresAt.getTime() !== current.expiresAt.getTime()) {
      const renewed = await db.playbackWindow.updateMany({
        data: { expiresAt },
        where: { id: windowId, mappingVersion: current.mappingVersion },
      })
      if (renewed.count !== 1) {
        throw new MediaHttpError(409, 'MAPPING_STALE', 'Playback window changed while renewing its lease')
      }
    }
    return buildPlaybackDescriptor({
      captureEndUs: current.captureEndUs,
      captureSessionId: current.captureSessionId,
      captureStartUs: current.captureStartUs,
      expiresAt,
      id: current.id,
      liveEdgeUs: current.dvrProgram.liveEdgeUs,
      mappingVersion: current.mappingVersion,
      mode: current.mode,
      presentationOriginCaptureUs: current.presentationOriginCaptureUs,
      targetPlayerMediaTimeUs: current.targetPlayerMediaTimeUs,
      timelineEndUs: selection.timelineEndUs,
      timelineStartUs: selection.timelineStartUs,
    })
  }
  const targetPlayerMediaTimeUs = targetUs - current.presentationOriginCaptureUs
  if (targetPlayerMediaTimeUs < 0n || targetUs >= selection.windowEndUs) {
    throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'Playback continuation target is invalid')
  }

  const mappingVersion = current.mappingVersion + 1
  try {
    await db.$transaction(async transaction => {
      await transaction.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`playback-window:${windowId}`}, 0))::text AS lock`
      const latest = await transaction.playbackWindow.findUnique({ where: { id: windowId } })
      if (!latest || latest.mappingVersion !== current.mappingVersion) {
        throw new MediaHttpError(409, 'MAPPING_STALE', 'Playback window was extended concurrently')
      }
      await transaction.playbackWindowSegment.deleteMany({ where: { playbackWindowId: windowId } })
      await transaction.playbackWindow.update({
        data: {
          captureStartUs: selection.windowStartUs,
          captureEndUs: selection.windowEndUs,
          mappingVersion,
          expiresAt,
          targetPlayerMediaTimeUs,
          timelineVersion: current.dvrProgram.playlistRevision,
          segments: {
            create: selection.segments.map((segment, sequenceIndex) => ({
              dvrSegmentId: segment.id,
              sequenceIndex,
            })),
          },
        },
        where: { id: windowId },
      })
    })
  }
  catch (error) {
    if (error instanceof MediaHttpError) throw error
    throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'Playback continuation could not be persisted')
  }
  return buildPlaybackDescriptor({
    captureEndUs: selection.windowEndUs,
    captureSessionId: current.captureSessionId,
    captureStartUs: selection.windowStartUs,
    expiresAt,
    id: current.id,
    liveEdgeUs: current.dvrProgram.liveEdgeUs,
    mappingVersion,
    mode: current.mode,
    presentationOriginCaptureUs: current.presentationOriginCaptureUs,
    targetPlayerMediaTimeUs,
    timelineEndUs: selection.timelineEndUs,
    timelineStartUs: selection.timelineStartUs,
  })
}

function selectedAsset(
  window: VisibleWindowWithSegments,
  token: string,
) {
  const resource = parsePlaybackResourceToken(token)
  const mapping = window.segments.find((entry) =>
    entry.dvrSegmentId.toLowerCase() === resource.dvrSegmentId)
  if (!mapping) {
    throw new MediaHttpError(404, 'NOT_FOUND', 'Media resource not found')
  }
  if (mapping.dvrSegment.isGap || mapping.dvrSegment.readyAt === null) {
    throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'Media resource is not ready')
  }
  const asset = resource.kind === 'init'
    ? mapping.dvrSegment.initAsset
    : mapping.dvrSegment.mediaAsset
  if (!assetMetadataReady(
    asset,
    'video/mp4',
    resource.kind === 'init' ? 'DVR_INIT' : 'DVR_SEGMENT',
  )) {
    throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'Media resource is not ready')
  }
  return asset
}

export const mediaPlaybackRoutes = (
  deps: MediaPlaybackDeps = {},
): FastifyPluginAsync => async (app) => {
  const now = deps.now ?? (() => new Date())

  app.post<{ Body: unknown }>(
    '/api/v1/media/playback-windows',
    async (request, reply) => {
      try {
        const identity = await authenticate(request, deps.authenticate)
        let body: PlaybackWindowRequest
        try {
          body = parsePlaybackWindowRequest(request.body)
        } catch {
          throw new MediaHttpError(400, 'BAD_REQUEST', 'Invalid playback window request')
        }
        return reply.send(await createPlaybackWindow(body, identity, deps))
      } catch (error) {
        return sendMediaError(request, reply, error)
      }
    },
  )

  app.get<{ Params: WindowParams }>(
    '/api/v1/media/playback-windows/:windowId',
    async (request, reply) => {
      try {
        const identity = await authenticate(request, deps.authenticate)
        const id = parseUuid(request.params.windowId, 'Playback window')
        const window = await visibleWindow(id, identity)
        if (!window) {
          throw new MediaHttpError(404, 'NOT_FOUND', 'Playback window not found')
        }
        assertWindowActive(window, now())
        return reply.send(await descriptorForWindow(window))
      } catch (error) {
        return sendMediaError(request, reply, error)
      }
    },
  )

  app.post<{ Body: unknown; Params: WindowParams }>(
    '/api/v1/media/playback-windows/:windowId/extend',
    async (request, reply) => {
      try {
        const identity = await authenticate(request, deps.authenticate)
        const id = parseUuid(request.params.windowId, 'Playback window')
        let body: PlaybackWindowExtendRequest
        try { body = parsePlaybackWindowExtendRequest(request.body) }
        catch { throw new MediaHttpError(400, 'BAD_REQUEST', 'Invalid playback window extend request') }
        return reply.send(await extendPlaybackWindow(id, body, identity, deps))
      }
      catch (error) {
        return sendMediaError(request, reply, error)
      }
    },
  )

  app.get<{ Params: WindowParams }>(
    '/api/v1/media/playback-windows/:windowId/manifest.m3u8',
    async (request, reply) => {
      try {
        const identity = await authenticate(request, deps.authenticate)
        const id = parseUuid(request.params.windowId, 'Playback window')
        const window = await visibleWindowWithSegments(id, identity)
        if (!window) {
          throw new MediaHttpError(404, 'NOT_FOUND', 'Playback window not found')
        }
        assertWindowActive(window, now())
        const bounds = timelineBounds((await loadProgramSegments(window.dvrProgramId)).map(toCandidate))
        const terminal = window.dvrProgram.status === 'FINISHED' && window.captureEndUs >= bounds.endUs
        return reply
          .type('application/vnd.apple.mpegurl')
          .header('cache-control', 'no-store, must-revalidate')
          .header('x-playback-mapping-version', String(window.mappingVersion))
          .send(formatManifest(window.id, manifestEntries(window), { endList: terminal }))
      } catch (error) {
        return sendMediaError(request, reply, error)
      }
    },
  )

  app.get<{ Params: ResourceParams }>(
    '/api/v1/media/playback-windows/:windowId/segments/:segmentId',
    async (request, reply) => {
      try {
        const identity = await authenticate(request, deps.authenticate)
        const id = parseUuid(request.params.windowId, 'Playback window')
        const window = await visibleWindowWithSegments(id, identity)
        if (!window) {
          throw new MediaHttpError(404, 'NOT_FOUND', 'Media resource not found')
        }
        assertWindowActive(window, now())
        const asset = selectedAsset(window, request.params.segmentId)
        if (!deps.objectReader) {
          throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'Media object reader unavailable')
        }
        let bytes: Uint8Array
        try {
          bytes = await deps.objectReader({
            bucket: asset.bucket,
            expectedByteLength: asset.byteLength,
            expectedContentType: asset.contentType,
            expectedInternalSchemaVersion: asset.internalSchemaVersion,
            expectedKind: asset.kind,
            expectedSha256: asset.sha256,
            key: asset.objectKey,
          })
        } catch {
          throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'Media object is unavailable')
        }
        return reply.type(asset.contentType).send(Buffer.from(bytes))
      } catch (error) {
        return sendMediaError(request, reply, error)
      }
    },
  )
}
