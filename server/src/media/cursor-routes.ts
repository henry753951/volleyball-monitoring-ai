import { randomUUID } from 'node:crypto'
import {
  parseFrameStepRequest,
  parsePlaybackCursor,
  type FrameStepRequest,
  type PlaybackCursor,
} from '@volleyball-monitoring/contracts'
import type { PrismaClient } from '@volleyball-monitoring/db'
import { UserRole } from '@volleyball-monitoring/db/client'
import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify'
import {
  resolvePlaybackCursor,
  stepCanonicalFrame,
  type CursorMediaIdentity,
  type CursorPlaybackWindow,
  type CursorResolutionDependencies,
  type CursorSampleIndexLoader,
  type CursorWindowSegment,
  type CursorWindowStore,
} from './cursor-resolution.js'
import {
  MediaHttpError,
  mediaErrorEnvelope,
  type MediaObjectReader,
} from './playback-domain.js'
import { createSampleIndexRepository } from './sample-index-repository.js'

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const USER_ROLES = new Set<UserRole>(Object.values(UserRole))

export interface MediaCursorRouteDependencies {
  authenticate?: (
    request: FastifyRequest,
  ) => Promise<CursorMediaIdentity | null>
  database?: PrismaClient
  now?: () => Date
  objectReader?: MediaObjectReader
  sampleIndexes?: CursorSampleIndexLoader
  store?: CursorWindowStore
}

interface PersistedSegment {
  id: string
  captureEpochId: string
  captureStartUs: bigint
  captureEndUs: bigint
  discontinuitySequence: number
  dvrProgramId: string
  firstFrameIndex: bigint | null
  frameCount: bigint
  isGap: boolean
  readyAt: Date | null
  sampleIndexAssetId: string | null
  sequenceNumber: bigint
}

function toWindowSegment(
  segment: PersistedSegment,
  sequenceIndex: number,
): CursorWindowSegment {
  return {
    captureEndUs: segment.captureEndUs,
    captureEpochId: segment.captureEpochId,
    captureStartUs: segment.captureStartUs,
    discontinuity: segment.discontinuitySequence,
    dvrProgramId: segment.dvrProgramId,
    firstFrameIndex: segment.firstFrameIndex,
    frameCount: segment.frameCount,
    id: segment.id,
    isGap: segment.isGap,
    ready: segment.readyAt !== null && segment.sampleIndexAssetId !== null,
    sequenceIndex,
    sequenceNumber: segment.sequenceNumber,
  }
}

export function createPrismaCursorWindowStore(
  database: PrismaClient,
): CursorWindowStore {
  return {
    async loadVisibleWindow(id, identity) {
      const row = await database.playbackWindow.findFirst({
        include: {
          dvrProgram: { select: { captureSessionId: true } },
          segments: {
            include: { dvrSegment: true },
            orderBy: { sequenceIndex: 'asc' },
          },
        },
        where: {
          id,
          ...(identity.role === UserRole.ADMIN
            ? {}
            : {
                captureSession: {
                  match: { members: { some: { userId: identity.id } } },
                },
              }),
        },
      })
      if (!row) return null
      return {
        captureEndUs: row.captureEndUs,
        captureSessionId: row.captureSessionId,
        captureStartUs: row.captureStartUs,
        dvrProgramId: row.dvrProgramId,
        expiresAt: row.expiresAt,
        id: row.id,
        mappingVersion: row.mappingVersion,
        presentationOriginCaptureUs: row.presentationOriginCaptureUs,
        programCaptureSessionId: row.dvrProgram.captureSessionId,
        segments: row.segments.map((mapping) =>
          toWindowSegment(mapping.dvrSegment, mapping.sequenceIndex)),
      }
    },

    async loadAdjacentSegment({ direction, edge, window }) {
      const row = await database.dvrSegment.findFirst({
        orderBy: {
          sequenceNumber: direction === 'next' ? 'asc' : 'desc',
        },
        where: {
          dvrProgramId: window.dvrProgramId,
          sequenceNumber: direction === 'next'
            ? { gt: edge.sequenceNumber }
            : { lt: edge.sequenceNumber },
        },
      })
      return row ? toWindowSegment(row, -1) : null
    },
  }
}

function headerValue(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name]
  return typeof value === 'string' ? value : null
}

async function defaultDevelopmentIdentity(
  request: FastifyRequest,
  database: PrismaClient,
): Promise<CursorMediaIdentity | null> {
  if (
    process.env.DEV_AUTH_ENABLED !== 'true'
    || process.env.NODE_ENV === 'production'
  ) return null

  const id = headerValue(request, 'x-dev-user-id')
    ?? process.env.DEV_USER_ID
    ?? null
  const roleValue = headerValue(request, 'x-dev-role')
    ?? process.env.DEV_USER_ROLE
    ?? null
  if (id === null && roleValue === null) return null
  if (id === null || !UUID.test(id) || roleValue === null) {
    throw new MediaHttpError(401, 'UNAUTHENTICATED', 'Invalid development identity')
  }
  if (!USER_ROLES.has(roleValue as UserRole)) {
    throw new MediaHttpError(401, 'UNAUTHENTICATED', 'Invalid development role')
  }

  await database.user.upsert({
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

async function authenticate(
  request: FastifyRequest,
  dependency: MediaCursorRouteDependencies['authenticate'],
  database: PrismaClient | undefined,
): Promise<CursorMediaIdentity> {
  const identity = dependency
    ? await dependency(request)
    : database
      ? await defaultDevelopmentIdentity(request, database)
      : null
  if (!identity) {
    throw new MediaHttpError(401, 'UNAUTHENTICATED', 'Authentication required')
  }
  if (!UUID.test(identity.id) || !USER_ROLES.has(identity.role)) {
    throw new MediaHttpError(401, 'UNAUTHENTICATED', 'Invalid identity')
  }
  return identity
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
  request.log.error({ err: error }, 'media cursor request failed')
  return reply.code(500).send(mediaErrorEnvelope(
    new MediaHttpError(500, 'MEDIA_NOT_READY', 'Media request failed'),
    requestId(request),
  ))
}

const unavailableSampleIndexes: CursorSampleIndexLoader = {
  async loadOrderedSegments() {
    throw new Error('sample index reader unavailable')
  },
}

export const mediaCursorRoutes = (
  deps: MediaCursorRouteDependencies = {},
): FastifyPluginAsync => async (app) => {
  const needsDatabase = deps.store === undefined
    || (deps.sampleIndexes === undefined && deps.objectReader !== undefined)
    || deps.authenticate === undefined
  const database = deps.database
    ?? (needsDatabase ? (await import('@volleyball-monitoring/db')).db : undefined)
  if (!deps.store && !database) {
    throw new Error('database is required for the media cursor store')
  }
  const serviceDeps: CursorResolutionDependencies = {
    now: deps.now ?? (() => new Date()),
    sampleIndexes: deps.sampleIndexes
      ?? (deps.objectReader
        ? createSampleIndexRepository(database!, deps.objectReader)
        : unavailableSampleIndexes),
    store: deps.store ?? createPrismaCursorWindowStore(database!),
  }

  app.post<{ Body: unknown }>(
    '/api/v1/media/resolve-cursor',
    async (request, reply) => {
      try {
        const identity = await authenticate(request, deps.authenticate, database)
        let body: PlaybackCursor
        try {
          body = parsePlaybackCursor(request.body)
        } catch {
          throw new MediaHttpError(400, 'BAD_REQUEST', 'Invalid playback cursor')
        }
        return reply.send(await resolvePlaybackCursor(body, identity, serviceDeps))
      } catch (error) {
        return sendMediaError(request, reply, error)
      }
    },
  )

  app.post<{ Body: unknown }>(
    '/api/v1/media/frame-step',
    async (request, reply) => {
      try {
        const identity = await authenticate(request, deps.authenticate, database)
        let body: FrameStepRequest
        try {
          body = parseFrameStepRequest(request.body)
        } catch {
          throw new MediaHttpError(400, 'BAD_REQUEST', 'Invalid frame step request')
        }
        return reply.send(await stepCanonicalFrame(body, identity, serviceDeps))
      } catch (error) {
        return sendMediaError(request, reply, error)
      }
    },
  )
}
