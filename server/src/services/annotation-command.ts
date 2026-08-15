import { createHash, randomUUID } from 'node:crypto'
import {
  parseAnnotationCommandResponse,
  type AnnotationCommand,
  type AnnotationCommandRejected,
  type AnnotationCommandResponse,
  type AnnotationResolvedAnchor,
  type CreateServiceKeyPointCommand,
  type PlaybackCursor,
  type ResolvedMediaAnchor,
} from '@volleyball-monitoring/contracts'
import type { PrismaClient } from '@volleyball-monitoring/db'
import { Prisma, UserRole } from '@volleyball-monitoring/db/client'
import {
  authorizeAnnotationRoom,
  type AnnotationIdentity,
  type AnnotationRoom,
} from '../domain/annotation/room.js'
import type { CursorMediaIdentity } from '../media/cursor-resolution.js'
import { MediaHttpError } from '../media/playback-domain.js'
import { submitRally } from '../domain/annotation/submission.js'

const SERIALIZABLE_RETRIES = 3

export interface AnnotationCommandServiceDependencies {
  database: PrismaClient
  beforeTransaction?: (command: AnnotationCommand) => Promise<void>
  resolveCursor: (
    cursor: PlaybackCursor,
    identity: CursorMediaIdentity,
  ) => Promise<ResolvedMediaAnchor>
}

export interface AnnotationCommandService {
  apply(
    command: AnnotationCommand,
    identity: AnnotationIdentity,
  ): Promise<AnnotationCommandResponse>
  authorizeRoom(roomId: string, identity: AnnotationIdentity): Promise<AnnotationRoom | null>
  roomSequence(roomId: string): Promise<bigint>
}

type Transaction = Prisma.TransactionClient

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function requestHash(command: AnnotationCommand): string {
  return createHash('sha256').update(canonicalJson(command)).digest('hex')
}

function rejected(
  command: AnnotationCommand,
  code: string,
  message: string,
  revision?: { expected: string | null; actual: string | null },
): AnnotationCommandRejected {
  return {
    schema_version: command.schema_version,
    type: 'command_rejected',
    command_id: command.command_id,
    room_id: command.room_id,
    rally_id: command.rally_id,
    code,
    message,
    ...(revision
      ? {
          actual_revision: revision.actual,
          expected_revision: revision.expected,
        }
      : {}),
    snapshot_refetch_required:
      code === 'REVISION_CONFLICT' || code === 'CLOSE_RALLY_TARGET_NOT_LAST',
  }
}

function wireAnchor(anchor: ResolvedMediaAnchor): AnnotationResolvedAnchor {
  return {
    playback_window_id: anchor.playback_window_id,
    capture_session_id: anchor.capture_session_id,
    capture_epoch_id: anchor.capture_epoch_id,
    ...(anchor.dvr_segment_id === undefined ? {} : { dvr_segment_id: anchor.dvr_segment_id }),
    source_pts: anchor.source_pts,
    source_time_base: anchor.source_time_base,
    capture_time_us: anchor.capture_time_us,
    capture_frame_index: anchor.capture_frame_index,
    resolved_player_media_time_us: anchor.resolved_player_media_time_us,
    mapping_version: anchor.mapping_version,
    ...(anchor.snap_distance_us === undefined ? {} : { snap_distance_us: anchor.snap_distance_us }),
    timing_precision: anchor.timing_precision,
  }
}

function toMediaCursor(command: {
  payload: { playback_cursor: CreateServiceKeyPointCommand['payload']['playback_cursor'] }
}): PlaybackCursor {
  return { schema_version: '1.0.0', ...command.payload.playback_cursor }
}

function isRetryable(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034'
}

async function serializable<T>(
  database: PrismaClient,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  let failure: unknown
  for (let attempt = 0; attempt < SERIALIZABLE_RETRIES; attempt += 1) {
    try {
      return await database.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      })
    } catch (error) {
      failure = error
      if (!isRetryable(error)) throw error
    }
  }
  throw failure
}

async function commandLock(tx: Transaction, commandId: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`annotation-command:${commandId}`}, 0))::text AS lock`
}

async function rallyLock(tx: Transaction, rallyId: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`annotation-rally:${rallyId}`}, 0))::text AS lock`
}

async function setAllocationLock(tx: Transaction, setId: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`annotation-set:${setId}`}, 0))::text AS lock`
}

async function nextTombstoneSequence(tx: Transaction, rallyId: string): Promise<number> {
  const aggregate = await tx.keyPoint.aggregate({
    _min: { sequenceIndex: true },
    where: { rallyId },
  })
  return Math.min(-1, (aggregate._min.sequenceIndex ?? 0) - 1)
}

async function rewriteActiveSequence(
  tx: Transaction,
  rallyId: string,
  ordered: Array<{ id: string }>,
): Promise<void> {
  const aggregate = await tx.keyPoint.aggregate({
    _min: { sequenceIndex: true },
    where: { rallyId },
  })
  const temporaryBase = Math.min(-1, (aggregate._min.sequenceIndex ?? 0) - ordered.length - 1)
  for (const [index, point] of ordered.entries()) {
    await tx.keyPoint.update({
      where: { id: point.id },
      data: { sequenceIndex: temporaryBase - index },
    })
  }
  for (const [sequenceIndex, point] of ordered.entries()) {
    await tx.keyPoint.update({ where: { id: point.id }, data: { sequenceIndex } })
  }
}

async function replay(
  database: PrismaClient | Transaction,
  command: AnnotationCommand,
  hash: string,
): Promise<AnnotationCommandResponse | null> {
  const receipt = await database.annotationCommandReceipt.findUnique({
    where: { commandId: command.command_id },
  })
  if (!receipt) return null
  if (receipt.requestHash !== hash) {
    return rejected(
      command,
      'COMMAND_ID_REUSED',
      'Command id was already used for a different request',
    )
  }
  return parseAnnotationCommandResponse(receipt.responseJson)
}

async function storeRejection(
  database: PrismaClient,
  command: AnnotationCommand,
  identity: AnnotationIdentity,
  hash: string,
  response: AnnotationCommandRejected,
): Promise<AnnotationCommandResponse> {
  return serializable(database, async tx => {
    await commandLock(tx, command.command_id)
    const existing = await replay(tx, command, hash)
    if (existing) return existing
    return persistRejection(tx, command, identity, hash, response)
  })
}

async function persistRejection(
  tx: Transaction,
  command: AnnotationCommand,
  identity: AnnotationIdentity,
  hash: string,
  response: AnnotationCommandRejected,
): Promise<AnnotationCommandRejected> {
  const receipt = await tx.annotationCommandReceipt.create({
    data: {
      accepted: false,
      commandId: command.command_id,
      deviceSessionId: identity.deviceSessionId,
      rallyId: command.rally_id,
      requestHash: hash,
      requestJson: jsonValue(command),
      responseJson: jsonValue(response),
      roomId: command.room_id,
      userId: identity.userId,
    },
  })
  await tx.outboxEvent.create({
    data: {
      aggregateId: command.rally_id,
      aggregateType: 'AnnotationCommandReceipt',
      dedupeKey: `annotation-rejected:${receipt.serverSequence}`,
      eventType: 'annotation.command_rejected.v2',
      payload: jsonValue(response),
    },
  })
  const stored = parseAnnotationCommandResponse(receipt.responseJson)
  if (stored.type !== 'command_rejected') throw new TypeError('Stored rejection is invalid')
  return stored
}

function mediaRejection(
  command: AnnotationCommand,
  error: MediaHttpError,
): AnnotationCommandRejected {
  return rejected(command, error.code, error.message)
}

async function selectCurrentSet(tx: Transaction, matchId: string) {
  const live = await tx.matchSet.findFirst({
    orderBy: [{ setNumber: 'desc' }, { id: 'desc' }],
    where: { matchId, status: 'LIVE' },
  })
  if (live) return live
  return tx.matchSet.findFirst({
    orderBy: [{ setNumber: 'asc' }, { id: 'asc' }],
    where: { matchId, status: 'PLANNED' },
  })
}

async function acceptService(
  database: PrismaClient,
  room: AnnotationRoom,
  command: CreateServiceKeyPointCommand | Extract<AnnotationCommand, { kind: 'START_RALLY' }>,
  identity: AnnotationIdentity,
  hash: string,
  anchor: ResolvedMediaAnchor,
): Promise<AnnotationCommandResponse> {
  return serializable(database, async tx => {
    await commandLock(tx, command.command_id)
    const existing = await replay(tx, command, hash)
    if (existing) return existing
    await rallyLock(tx, command.rally_id)

    const [device, authorizedMatch] = await Promise.all([
      tx.deviceSession.findUnique({
        select: { revokedAt: true, userId: true },
        where: { id: identity.deviceSessionId },
      }),
      tx.match.findFirst({
        select: { clipPostRollUs: true, clipPreRollUs: true, id: true },
        where: {
          id: room.matchId,
          captureSessions: { some: { id: room.captureSessionId } },
          ...(identity.role === UserRole.ADMIN
            ? {}
            : {
                members: {
                  some: {
                    role: { in: [UserRole.ADMIN, UserRole.OPERATOR, UserRole.ANNOTATOR] },
                    userId: identity.userId,
                  },
                },
              }),
        },
      }),
    ])
    if (!device) throw new TypeError('Authenticated device session no longer exists')
    if (device.userId !== identity.userId || device.revokedAt) {
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(command, 'UNAUTHENTICATED', 'Authenticated device session is no longer active'),
      )
    }
    if (!authorizedMatch) {
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(
          command,
          'ROOM_AUTHORIZATION_STALE',
          'Annotation room authorization changed before commit',
        ),
      )
    }

    const conflicting = await tx.rally.findUnique({
      select: { annotationRevision: true },
      where: { id: command.rally_id },
    })
    if (conflicting) {
      const response = rejected(command, 'REVISION_CONFLICT', 'Rally already exists', {
        actual: conflicting.annotationRevision.toString(),
        expected: '0',
      })
      return persistRejection(tx, command, identity, hash, response)
    }

    const segmentId = anchor.dvr_segment_id
    const playbackWindowPromise =
      segmentId === null || segmentId === undefined
        ? Promise.resolve(null)
        : tx.playbackWindow.findFirst({
            select: {
              captureEndUs: true,
              captureStartUs: true,
              dvrProgramId: true,
              mappingVersion: true,
              presentationOriginCaptureUs: true,
              segments: {
                select: {
                  dvrSegment: {
                    select: {
                      captureEndUs: true,
                      captureEpochId: true,
                      captureStartUs: true,
                      dvrProgramId: true,
                      firstFrameIndex: true,
                      frameCount: true,
                      id: true,
                      isGap: true,
                      readyAt: true,
                      sampleIndexAssetId: true,
                    },
                  },
                },
                where: { dvrSegmentId: segmentId },
              },
            },
            where: {
              captureSessionId: room.captureSessionId,
              dvrProgram: { captureSessionId: room.captureSessionId },
              id: anchor.playback_window_id,
            },
          })
    const [playbackWindow, set, epoch] = await Promise.all([
      playbackWindowPromise,
      selectCurrentSet(tx, room.matchId),
      tx.captureEpoch.findFirst({
        select: { id: true },
        where: { captureSessionId: room.captureSessionId, id: anchor.capture_epoch_id },
      }),
    ])
    const mappedSegment =
      segmentId === null || segmentId === undefined
        ? null
        : (playbackWindow?.segments[0]?.dvrSegment ?? null)
    const captureTimeUs = BigInt(anchor.capture_time_us)
    const captureFrameIndex = BigInt(anchor.capture_frame_index)
    const resolvedPlayerMediaTimeUs = BigInt(anchor.resolved_player_media_time_us)
    const segmentContainsFrame =
      mappedSegment?.firstFrameIndex !== null &&
      mappedSegment?.firstFrameIndex !== undefined &&
      captureFrameIndex >= mappedSegment.firstFrameIndex &&
      captureFrameIndex < mappedSegment.firstFrameIndex + mappedSegment.frameCount
    if (
      !playbackWindow ||
      !set ||
      !epoch ||
      !mappedSegment ||
      anchor.capture_session_id !== room.captureSessionId ||
      playbackWindow.mappingVersion !== anchor.mapping_version ||
      command.payload.playback_cursor.playback_window_id !== anchor.playback_window_id ||
      command.payload.playback_cursor.mapping_version !== anchor.mapping_version ||
      mappedSegment.id !== segmentId ||
      mappedSegment.dvrProgramId !== playbackWindow.dvrProgramId ||
      mappedSegment.captureEpochId !== anchor.capture_epoch_id ||
      mappedSegment.isGap ||
      mappedSegment.readyAt === null ||
      mappedSegment.sampleIndexAssetId === null ||
      captureTimeUs < playbackWindow.captureStartUs ||
      captureTimeUs >= playbackWindow.captureEndUs ||
      captureTimeUs < mappedSegment.captureStartUs ||
      captureTimeUs >= mappedSegment.captureEndUs ||
      !segmentContainsFrame ||
      resolvedPlayerMediaTimeUs !== captureTimeUs - playbackWindow.presentationOriginCaptureUs
    ) {
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(command, 'ANNOTATION_NOT_READY', 'Resolved playback state is no longer valid'),
      )
    }

    await setAllocationLock(tx, set.id)
    const activeDraft = await tx.rally.findFirst({
      select: { id: true },
      where: {
        activeSubmissionId: null,
        annotationStatus: 'OPEN',
        matchId: room.matchId,
        voidedAt: null,
        OR: [
          { boundaries: { some: { deviceSessionId: identity.deviceSessionId, kind: 'START' } } },
          {
            keyPoints: {
              some: { deviceSessionId: identity.deviceSessionId, markerKind: 'SERVICE' },
            },
          },
        ],
      },
    })
    if (activeDraft) {
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(
          command,
          'ACTIVE_RALLY_EXISTS',
          'The current set already has an editable rally draft',
        ),
      )
    }
    const proposedStart =
      captureTimeUs > authorizedMatch.clipPreRollUs
        ? captureTimeUs - authorizedMatch.clipPreRollUs
        : 0n
    const proposedEnd =
      captureTimeUs + (authorizedMatch.clipPostRollUs > 0n ? authorizedMatch.clipPostRollUs : 1n)
    const overlapsExisting = await clipRangeOverlapsExistingRally(
      tx,
      room.matchId,
      proposedStart,
      proposedEnd,
      authorizedMatch.clipPreRollUs,
      authorizedMatch.clipPostRollUs,
    )
    if (overlapsExisting) {
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(
          command,
          'ANNOTATION_NOT_READY',
          'The configured clip range would overlap an existing segment',
        ),
      )
    }
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${room.matchId}))`
    // Rally.ordinal is an append-only internal allocation used by immutable
    // submissions and side-assignment history. Product naming never reads it;
    // the dashboard derives the visible number from canonical capture time.
    const aggregate = await tx.rally.aggregate({
      _max: { ordinal: true },
      where: { setId: set.id },
    })
    const internalOrdinal = (aggregate._max.ordinal ?? 0) + 1
    const assignment = await tx.courtSideAssignment.findFirst({
      orderBy: { effectiveFromRallyOrdinal: 'desc' },
      where: {
        effectiveFromRallyOrdinal: { lte: internalOrdinal },
        OR: [
          { effectiveToRallyOrdinal: null },
          { effectiveToRallyOrdinal: { gte: internalOrdinal } },
        ],
        setId: set.id,
      },
    })
    if (!assignment) {
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(command, 'ANNOTATION_NOT_READY', 'Court-side assignment is not ready'),
      )
    }
    const anchorId = randomUUID()
    await tx.rally.create({
      data: {
        annotationRevision: 1n,
        dvrProgramId: playbackWindow.dvrProgramId,
        id: command.rally_id,
        matchId: room.matchId,
        ordinal: internalOrdinal,
        displayOrdinal: 1,
        displaySetNumber: set.setNumber,
        setId: set.id,
        sideAssignmentId: assignment.id,
        sideAssignmentReversed: false,
        scoreResolutionState: command.kind === 'START_RALLY' ? 'PENDING' : 'UNKNOWN',
      },
    })
    if (command.kind === 'START_RALLY') {
      await tx.rallyBoundary.create({
        data: {
          captureEpochId: anchor.capture_epoch_id,
          captureFrameIndex: BigInt(anchor.capture_frame_index),
          captureTimeUs: BigInt(anchor.capture_time_us),
          createdByUserId: identity.userId,
          deviceSessionId: identity.deviceSessionId,
          id: anchorId,
          kind: 'START',
          originalPlaybackCursor: jsonValue(command.payload.playback_cursor),
          rallyId: command.rally_id,
          snapDistanceUs: anchor.snap_distance_us == null ? null : BigInt(anchor.snap_distance_us),
          sourcePts: BigInt(anchor.source_pts),
          timingPrecision: anchor.timing_precision.toUpperCase() as
            'FRAME_EXACT' | 'PTS_EXACT' | 'ESTIMATED',
          updatedByUserId: identity.userId,
        },
      })
    } else {
      await tx.keyPoint.create({
        data: {
          captureEpochId: anchor.capture_epoch_id,
          captureFrameIndex: BigInt(anchor.capture_frame_index),
          captureTimeUs: BigInt(anchor.capture_time_us),
          createdByUserId: identity.userId,
          deviceSessionId: identity.deviceSessionId,
          id: anchorId,
          markerKind: 'SERVICE',
          originalPlaybackCursor: jsonValue(command.payload.playback_cursor),
          rallyId: command.rally_id,
          sequenceIndex: 0,
          snapDistanceUs: anchor.snap_distance_us == null ? null : BigInt(anchor.snap_distance_us),
          sourcePts: BigInt(anchor.source_pts),
          timingPrecision: anchor.timing_precision.toUpperCase() as
            'FRAME_EXACT' | 'PTS_EXACT' | 'ESTIMATED',
          updatedByUserId: identity.userId,
        },
      })
    }
    const receipt = await tx.annotationCommandReceipt.create({
      data: {
        accepted: true,
        commandId: command.command_id,
        deviceSessionId: identity.deviceSessionId,
        rallyId: command.rally_id,
        requestHash: hash,
        requestJson: jsonValue(command),
        responseJson: {},
        roomId: command.room_id,
        userId: identity.userId,
      },
    })
    const response = parseAnnotationCommandResponse({
      schema_version: command.kind === 'START_RALLY' ? '3.0.0' : '2.0.0',
      type: 'command_ack',
      command_id: command.command_id,
      room_id: command.room_id,
      rally_id: command.rally_id,
      operation_kind: command.kind,
      result_revision: '1',
      server_sequence: receipt.serverSequence.toString(),
      effects: {
        annotation_status: 'open',
        ...(command.kind === 'START_RALLY'
          ? { boundary_kind: 'start' as const }
          : { created_key_point_id: anchorId }),
        score_resolution: command.kind === 'START_RALLY' ? 'pending' : 'unknown',
        scoring_court_side: null,
      },
      resolved_anchor: wireAnchor(anchor),
    })
    const storedReceipt = await tx.annotationCommandReceipt.update({
      data: { responseJson: jsonValue(response) },
      select: { responseJson: true },
      where: { serverSequence: receipt.serverSequence },
    })
    await tx.annotationOperation.create({
      data: {
        baseRevision: 0n,
        clientMutationId: command.command_id,
        deviceSessionId: identity.deviceSessionId,
        operationKind: command.kind,
        payload: jsonValue(command.payload),
        payloadHash: hash,
        rallyId: command.rally_id,
        receiptServerSequence: receipt.serverSequence,
        resultRevision: 1n,
        userId: identity.userId,
      },
    })
    await tx.outboxEvent.create({
      data: {
        aggregateId: command.rally_id,
        aggregateType: 'Rally',
        dedupeKey: `annotation-accepted:${receipt.serverSequence}`,
        eventType: 'annotation.command_accepted.v2',
        payload: jsonValue(response),
      },
    })
    const stored = parseAnnotationCommandResponse(storedReceipt.responseJson)
    if (stored.type !== 'command_ack') throw new TypeError('Stored acknowledgement is invalid')
    return stored
  })
}

type ContactCommand = Extract<AnnotationCommand, { kind: 'CREATE_CONTACT_KEY_POINT' }>
type EndCommand = Extract<AnnotationCommand, { kind: 'END_RALLY' }>
type CloseCommand = Extract<AnnotationCommand, { kind: 'CLOSE_RALLY' }>
type OutcomeCommand = Extract<AnnotationCommand, { kind: 'SET_RALLY_OUTCOME' }>
type EditCommand = Extract<
  AnnotationCommand,
  { kind: 'MOVE_KEY_POINT' | 'DELETE_KEY_POINT' | 'REOPEN_RALLY' | 'VOID_RALLY' }
>

function ordinaryDraftBelongsToDevice(
  rally: {
    activeSubmissionId: string | null
    boundaries?: Array<{ kind: string; deviceSessionId: string }>
    keyPoints?: Array<{ markerKind: string; deviceSessionId: string }>
    operations?: Array<{ deviceSessionId: string }>
  },
  deviceSessionId: string,
) {
  if (rally.activeSubmissionId !== null) return true
  const owner =
    rally.boundaries?.find(boundary => boundary.kind === 'START')?.deviceSessionId ??
    rally.keyPoints?.find(point => point.markerKind === 'SERVICE')?.deviceSessionId ??
    rally.operations?.[0]?.deviceSessionId
  return owner === deviceSessionId
}

async function acceptContact(
  database: PrismaClient,
  room: AnnotationRoom,
  command: ContactCommand | EndCommand,
  identity: AnnotationIdentity,
  hash: string,
  anchor: ResolvedMediaAnchor,
): Promise<AnnotationCommandResponse> {
  return serializable(database, async tx => {
    await commandLock(tx, command.command_id)
    const existing = await replay(tx, command, hash)
    if (existing) return existing
    await rallyLock(tx, command.rally_id)
    const rally = await tx.rally.findUnique({
      where: { id: command.rally_id },
      include: {
        boundaries: true,
        keyPoints: {
          where: { deletedAt: null },
          orderBy: [
            { captureTimeUs: 'asc' },
            { captureFrameIndex: 'asc' },
            { sequenceIndex: 'asc' },
          ],
        },
        operations: { orderBy: { resultRevision: 'asc' }, take: 1 },
      },
    })
    const device = await tx.deviceSession.findUnique({
      select: { revokedAt: true, userId: true },
      where: { id: identity.deviceSessionId },
    })
    if (!device || device.userId !== identity.userId || device.revokedAt)
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(command, 'UNAUTHENTICATED', 'Authenticated device session is no longer active'),
      )
    const authorizedMatch = await tx.match.findFirst({
      select: { clipPostRollUs: true, clipPreRollUs: true, id: true },
      where: {
        id: room.matchId,
        captureSessions: { some: { id: room.captureSessionId } },
        ...(identity.role === UserRole.ADMIN
          ? {}
          : {
              members: {
                some: {
                  userId: identity.userId,
                  role: { in: [UserRole.ADMIN, UserRole.OPERATOR, UserRole.ANNOTATOR] },
                },
              },
            }),
      },
    })
    if (!authorizedMatch)
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(
          command,
          'ROOM_AUTHORIZATION_STALE',
          'Annotation room authorization changed before commit',
        ),
      )
    const editableStatuses =
      command.kind === 'END_RALLY' || command.payload.terminal_outcome === 'unknown'
        ? ['OPEN']
        : ['OPEN', 'READY']
    if (
      !rally ||
      rally.matchId !== room.matchId ||
      !editableStatuses.includes(rally.annotationStatus)
    )
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(command, 'RALLY_NOT_OPEN', 'Rally is not an editable draft'),
      )
    if (!ordinaryDraftBelongsToDevice(rally, identity.deviceSessionId))
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(command, 'RALLY_OWNED_BY_OTHER_CLIENT', '這個片段屬於另一個標註客戶端'),
      )
    await setAllocationLock(tx, rally.setId)
    if (command.base_revision !== rally.annotationRevision.toString())
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(command, 'REVISION_CONFLICT', 'Rally revision is stale', {
          actual: rally.annotationRevision.toString(),
          expected: command.base_revision,
        }),
      )
    const mapping = anchor.dvr_segment_id
      ? await tx.playbackWindow.findFirst({
          where: {
            id: anchor.playback_window_id,
            captureSessionId: room.captureSessionId,
            mappingVersion: anchor.mapping_version,
            segments: {
              some: {
                dvrSegment: {
                  id: anchor.dvr_segment_id,
                  captureEpochId: anchor.capture_epoch_id,
                  dvrProgramId: rally.dvrProgramId,
                  isGap: false,
                  readyAt: { not: null },
                  sampleIndexAssetId: { not: null },
                },
              },
            },
          },
          select: {
            captureEndUs: true,
            captureStartUs: true,
            dvrProgramId: true,
            mappingVersion: true,
            presentationOriginCaptureUs: true,
            segments: {
              where: { dvrSegmentId: anchor.dvr_segment_id },
              select: {
                dvrSegment: {
                  select: {
                    captureEndUs: true,
                    captureStartUs: true,
                    firstFrameIndex: true,
                    frameCount: true,
                    captureEpochId: true,
                    dvrProgramId: true,
                    isGap: true,
                    readyAt: true,
                    sampleIndexAssetId: true,
                  },
                },
              },
            },
          },
        })
      : null
    const epoch = await tx.captureEpoch.findFirst({
      where: { id: anchor.capture_epoch_id, captureSessionId: room.captureSessionId },
    })
    const segment = mapping?.segments[0]?.dvrSegment
    const resolvedTime = BigInt(anchor.capture_time_us)
    const resolvedFrame = BigInt(anchor.capture_frame_index)
    const playerTime = BigInt(anchor.resolved_player_media_time_us)
    const valid =
      anchor.capture_session_id === room.captureSessionId &&
      !!mapping &&
      !!segment &&
      !!epoch &&
      mapping.dvrProgramId === rally.dvrProgramId &&
      segment.dvrProgramId === rally.dvrProgramId &&
      segment.captureEpochId === anchor.capture_epoch_id &&
      !segment.isGap &&
      segment.readyAt !== null &&
      segment.sampleIndexAssetId !== null &&
      resolvedTime >= mapping.captureStartUs &&
      resolvedTime < mapping.captureEndUs &&
      resolvedTime >= segment.captureStartUs &&
      resolvedTime < segment.captureEndUs &&
      segment.firstFrameIndex !== null &&
      segment.firstFrameIndex !== undefined &&
      resolvedFrame >= segment.firstFrameIndex &&
      resolvedFrame < segment.firstFrameIndex + segment.frameCount &&
      playerTime === resolvedTime - mapping.presentationOriginCaptureUs &&
      anchor.playback_window_id === command.payload.playback_cursor.playback_window_id &&
      anchor.mapping_version === command.payload.playback_cursor.mapping_version
    if (!valid)
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(command, 'ANNOTATION_NOT_READY', 'Resolved playback state is no longer valid'),
      )
    const allPoints = rally.keyPoints
    if (command.kind === 'END_RALLY') {
      const start = rally.boundaries.find(boundary => boundary.kind === 'START')
      if (!start)
        return persistRejection(
          tx,
          command,
          identity,
          hash,
          rejected(command, 'ANNOTATION_NOT_READY', 'Rally start boundary is missing'),
        )
      if (
        resolvedTime < start.captureTimeUs ||
        (resolvedTime === start.captureTimeUs && resolvedFrame <= start.captureFrameIndex)
      ) {
        return persistRejection(
          tx,
          command,
          identity,
          hash,
          rejected(command, 'ANNOTATION_NOT_READY', 'Rally end must be after its start boundary'),
        )
      }
      const proposedTimes = [
        ...rally.boundaries.map(boundary => boundary.captureTimeUs),
        ...allPoints.map(point => point.captureTimeUs),
        resolvedTime,
      ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      const paddedStart = proposedTimes[0]! - authorizedMatch.clipPreRollUs
      const proposedStart = paddedStart < 0n ? 0n : paddedStart
      const proposedEnd = proposedTimes.at(-1)! + authorizedMatch.clipPostRollUs
      if (
        await clipRangeOverlapsExistingRally(
          tx,
          room.matchId,
          proposedStart,
          proposedEnd,
          authorizedMatch.clipPreRollUs,
          authorizedMatch.clipPostRollUs,
          rally.id,
        )
      ) {
        return persistRejection(
          tx,
          command,
          identity,
          hash,
          rejected(command, 'ANNOTATION_NOT_READY', 'Rally end would overlap another segment'),
        )
      }
      await tx.rallyBoundary.create({
        data: {
          captureEpochId: anchor.capture_epoch_id,
          captureFrameIndex: resolvedFrame,
          captureTimeUs: resolvedTime,
          createdByUserId: identity.userId,
          deviceSessionId: identity.deviceSessionId,
          kind: 'END',
          originalPlaybackCursor: jsonValue(command.payload.playback_cursor),
          rallyId: command.rally_id,
          snapDistanceUs: anchor.snap_distance_us == null ? null : BigInt(anchor.snap_distance_us),
          sourcePts: BigInt(anchor.source_pts),
          timingPrecision: anchor.timing_precision.toUpperCase() as
            'FRAME_EXACT' | 'PTS_EXACT' | 'ESTIMATED',
          updatedByUserId: identity.userId,
        },
      })
      const revision = rally.annotationRevision + 1n
      const scoreResolutionState =
        rally.scoreResolutionState === 'PENDING' ? 'UNKNOWN' : rally.scoreResolutionState
      const scoringCourtSide = scoreResolutionState === 'RESOLVED' ? rally.scoringCourtSide : null
      const cas = await tx.rally.updateMany({
        data: {
          annotationRevision: revision,
          annotationStatus: 'READY',
          scoreResolutionState,
          scoringCourtSide,
        },
        where: {
          id: rally.id,
          annotationRevision: rally.annotationRevision,
          annotationStatus: 'OPEN',
        },
      })
      if (cas.count !== 1)
        throw new Prisma.PrismaClientKnownRequestError('Rally changed concurrently', {
          code: 'P2034',
          clientVersion: 'annotation-v3',
        })
      const receipt = await tx.annotationCommandReceipt.create({
        data: {
          accepted: true,
          commandId: command.command_id,
          deviceSessionId: identity.deviceSessionId,
          rallyId: command.rally_id,
          requestHash: hash,
          requestJson: jsonValue(command),
          responseJson: {},
          roomId: command.room_id,
          userId: identity.userId,
        },
      })
      const response = parseAnnotationCommandResponse({
        schema_version: '3.0.0',
        type: 'command_ack',
        command_id: command.command_id,
        room_id: command.room_id,
        rally_id: command.rally_id,
        operation_kind: command.kind,
        result_revision: revision.toString(),
        server_sequence: receipt.serverSequence.toString(),
        effects: {
          annotation_status: 'ready',
          boundary_kind: 'end',
          score_resolution: scoreResolutionState.toLowerCase(),
          scoring_court_side: scoringCourtSide?.toLowerCase() ?? null,
        },
        resolved_anchor: wireAnchor(anchor),
      })
      await tx.annotationCommandReceipt.update({
        data: { responseJson: jsonValue(response) },
        where: { serverSequence: receipt.serverSequence },
      })
      await tx.annotationOperation.create({
        data: {
          baseRevision: rally.annotationRevision,
          clientMutationId: command.command_id,
          deviceSessionId: identity.deviceSessionId,
          operationKind: command.kind,
          payload: jsonValue(command.payload),
          payloadHash: hash,
          rallyId: command.rally_id,
          receiptServerSequence: receipt.serverSequence,
          resultRevision: revision,
          userId: identity.userId,
        },
      })
      await tx.outboxEvent.create({
        data: {
          aggregateId: command.rally_id,
          aggregateType: 'Rally',
          dedupeKey: `annotation-accepted:${receipt.serverSequence}`,
          eventType: 'annotation.command_accepted.v3',
          payload: jsonValue(response),
        },
      })
      return response
    }
    const servicePoint = allPoints.find(point => point.markerKind === 'SERVICE')
    const startBoundary = rally.boundaries.find(boundary => boundary.kind === 'START')
    const terminal = command.payload.terminal_outcome === 'unknown'
    const captureTime = BigInt(anchor.capture_time_us)
    const captureFrame = BigInt(anchor.capture_frame_index)
    if (!servicePoint && !startBoundary)
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(command, 'ANNOTATION_NOT_READY', 'Rally start boundary is missing'),
      )
    if (terminal && !servicePoint)
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(
          command,
          'ANNOTATION_NOT_READY',
          'Legacy terminal contact requires a service anchor',
        ),
      )
    if (
      terminal &&
      servicePoint &&
      (captureTime < servicePoint.captureTimeUs ||
        (captureTime === servicePoint.captureTimeUs &&
          captureFrame <= servicePoint.captureFrameIndex))
    )
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(command, 'ANNOTATION_NOT_READY', 'Rally end must be after service'),
      )
    const lastPoint = allPoints.at(-1)
    if (
      terminal &&
      lastPoint &&
      (captureTime < lastPoint.captureTimeUs ||
        (captureTime === lastPoint.captureTimeUs && captureFrame <= lastPoint.captureFrameIndex))
    )
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(command, 'ANNOTATION_NOT_READY', 'Rally end must be after the last key point'),
      )
    const firstContactIndex = servicePoint ? 1 : 0
    const foundIndex = allPoints.findIndex(
      point =>
        point.sequenceIndex >= firstContactIndex &&
        (point.captureTimeUs > captureTime ||
          (point.captureTimeUs === captureTime && point.captureFrameIndex > captureFrame)),
    )
    const insertion = foundIndex >= 0 ? Math.max(firstContactIndex, foundIndex) : allPoints.length
    for (const point of allPoints
      .filter(point => point.sequenceIndex >= insertion)
      .sort((a, b) => b.sequenceIndex - a.sequenceIndex))
      await tx.keyPoint.update({
        data: { sequenceIndex: { increment: 1 } },
        where: { id: point.id },
      })
    const equals = allPoints.filter(
      point => point.markerKind === 'CONTACT' && point.captureFrameIndex === captureFrame,
    )
    const possibleDuplicate = equals.length > 0
    for (const point of equals)
      if (!point.possibleDuplicate)
        await tx.keyPoint.update({ data: { possibleDuplicate: true }, where: { id: point.id } })
    const keyPointId = randomUUID()
    const sequenceIndex = insertion
    await tx.keyPoint.create({
      data: {
        captureEpochId: anchor.capture_epoch_id,
        captureFrameIndex: BigInt(anchor.capture_frame_index),
        captureTimeUs: BigInt(anchor.capture_time_us),
        createdByUserId: identity.userId,
        deviceSessionId: identity.deviceSessionId,
        id: keyPointId,
        isTerminal: terminal,
        markerKind: 'CONTACT',
        originalPlaybackCursor: jsonValue(command.payload.playback_cursor),
        rallyId: command.rally_id,
        sequenceIndex,
        snapDistanceUs: anchor.snap_distance_us == null ? null : BigInt(anchor.snap_distance_us),
        sourcePts: BigInt(anchor.source_pts),
        timingPrecision: anchor.timing_precision.toUpperCase() as
          'FRAME_EXACT' | 'PTS_EXACT' | 'ESTIMATED',
        updatedByUserId: identity.userId,
        possibleDuplicate,
      },
    })
    const revision = rally.annotationRevision + 1n
    const cas = await tx.rally.updateMany({
      data: terminal
        ? {
            annotationRevision: revision,
            annotationStatus: 'READY',
            scoreResolutionState: 'UNKNOWN',
            scoringCourtSide: null,
          }
        : { annotationRevision: revision },
      where: {
        id: rally.id,
        annotationRevision: rally.annotationRevision,
        annotationStatus: rally.annotationStatus,
      },
    })
    if (cas.count !== 1)
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(command, 'REVISION_CONFLICT', 'Rally revision is stale', {
          actual: rally.annotationRevision.toString(),
          expected: command.base_revision,
        }),
      )
    const receipt = await tx.annotationCommandReceipt.create({
      data: {
        accepted: true,
        commandId: command.command_id,
        deviceSessionId: identity.deviceSessionId,
        rallyId: command.rally_id,
        requestHash: hash,
        requestJson: jsonValue(command),
        responseJson: {},
        roomId: command.room_id,
        userId: identity.userId,
      },
    })
    const response = parseAnnotationCommandResponse({
      schema_version: command.schema_version,
      type: 'command_ack',
      command_id: command.command_id,
      room_id: command.room_id,
      rally_id: command.rally_id,
      operation_kind: command.kind,
      result_revision: revision.toString(),
      server_sequence: receipt.serverSequence.toString(),
      effects: terminal
        ? {
            annotation_status: 'ready',
            created_key_point_id: keyPointId,
            terminal_key_point_id: keyPointId,
            score_resolution: 'unknown',
            scoring_court_side: null,
          }
        : {
            annotation_status: rally.annotationStatus.toLowerCase(),
            created_key_point_id: keyPointId,
            score_resolution: rally.scoreResolutionState.toLowerCase(),
            scoring_court_side: rally.scoringCourtSide?.toLowerCase() ?? null,
          },
      resolved_anchor: wireAnchor(anchor),
    })
    await tx.annotationCommandReceipt.update({
      data: { responseJson: jsonValue(response) },
      where: { serverSequence: receipt.serverSequence },
    })
    await tx.annotationOperation.create({
      data: {
        baseRevision: rally.annotationRevision,
        clientMutationId: command.command_id,
        deviceSessionId: identity.deviceSessionId,
        operationKind: command.kind,
        payload: jsonValue(command.payload),
        payloadHash: hash,
        rallyId: command.rally_id,
        receiptServerSequence: receipt.serverSequence,
        resultRevision: revision,
        userId: identity.userId,
      },
    })
    await tx.outboxEvent.create({
      data: {
        aggregateId: command.rally_id,
        aggregateType: 'Rally',
        dedupeKey: `annotation-accepted:${receipt.serverSequence}`,
        eventType: `annotation.command_accepted.v${command.schema_version.startsWith('3.') ? '3' : '2'}`,
        payload: jsonValue(response),
      },
    })
    return response
  })
}

async function acceptClose(
  database: PrismaClient,
  room: AnnotationRoom,
  command: CloseCommand,
  identity: AnnotationIdentity,
  hash: string,
): Promise<AnnotationCommandResponse> {
  return serializable(database, async tx => {
    await commandLock(tx, command.command_id)
    const existing = await replay(tx, command, hash)
    if (existing) return existing
    await rallyLock(tx, command.rally_id)
    const rally = await tx.rally.findUnique({
      where: { id: command.rally_id },
      include: {
        keyPoints: { where: { deletedAt: null }, orderBy: { sequenceIndex: 'desc' }, take: 1 },
        operations: { orderBy: { resultRevision: 'asc' }, take: 1 },
      },
    })
    const device = await tx.deviceSession.findUnique({
      select: { revokedAt: true, userId: true },
      where: { id: identity.deviceSessionId },
    })
    if (!device || device.userId !== identity.userId || device.revokedAt)
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(command, 'UNAUTHENTICATED', 'Authenticated device session is no longer active'),
      )
    const authorizedMatch = await tx.match.findFirst({
      select: { id: true },
      where: {
        id: room.matchId,
        captureSessions: { some: { id: room.captureSessionId } },
        ...(identity.role === UserRole.ADMIN
          ? {}
          : {
              members: {
                some: {
                  userId: identity.userId,
                  role: { in: [UserRole.ADMIN, UserRole.OPERATOR, UserRole.ANNOTATOR] },
                },
              },
            }),
      },
    })
    if (!authorizedMatch)
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(
          command,
          'ROOM_AUTHORIZATION_STALE',
          'Annotation room authorization changed before commit',
        ),
      )
    if (!rally || rally.matchId !== room.matchId)
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(command, 'RALLY_NOT_FOUND', 'Rally was not found'),
      )
    if (!ordinaryDraftBelongsToDevice(rally, identity.deviceSessionId))
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(command, 'RALLY_OWNED_BY_OTHER_CLIENT', '這個片段屬於另一個標註客戶端'),
      )
    await setAllocationLock(tx, rally.setId)
    if (!['OPEN', 'READY'].includes(rally.annotationStatus))
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(command, 'RALLY_ALREADY_READY', 'Rally is not an editable draft'),
      )
    if (rally.annotationRevision.toString() !== command.base_revision)
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(command, 'REVISION_CONFLICT', 'Rally revision is stale', {
          actual: rally.annotationRevision.toString(),
          expected: command.base_revision,
        }),
      )
    const target = rally.keyPoints[0]
    if (!target || target.id !== command.payload.target_key_point_id)
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(command, 'CLOSE_RALLY_TARGET_NOT_LAST', 'Close target is not the last key point'),
      )
    const revision = rally.annotationRevision + 1n
    const resolution = command.payload.score_resolution === 'resolved' ? 'RESOLVED' : 'UNKNOWN'
    await tx.keyPoint.update({
      data: { isTerminal: true, updatedByUserId: identity.userId },
      where: { id: target.id },
    })
    const cas = await tx.rally.updateMany({
      data: {
        annotationRevision: revision,
        annotationStatus: 'READY',
        scoreResolutionState: resolution,
        scoringCourtSide:
          command.payload.scoring_court_side === null
            ? null
            : (command.payload.scoring_court_side.toUpperCase() as 'LEFT' | 'RIGHT'),
      },
      where: {
        id: rally.id,
        annotationRevision: rally.annotationRevision,
        annotationStatus: { in: ['OPEN', 'READY'] },
      },
    })
    if (cas.count !== 1)
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(command, 'REVISION_CONFLICT', 'Rally revision is stale', {
          actual: rally.annotationRevision.toString(),
          expected: command.base_revision,
        }),
      )
    const receipt = await tx.annotationCommandReceipt.create({
      data: {
        accepted: true,
        commandId: command.command_id,
        deviceSessionId: identity.deviceSessionId,
        rallyId: command.rally_id,
        requestHash: hash,
        requestJson: jsonValue(command),
        responseJson: {},
        roomId: command.room_id,
        userId: identity.userId,
      },
    })
    const response = parseAnnotationCommandResponse({
      schema_version: '2.0.0',
      type: 'command_ack',
      command_id: command.command_id,
      room_id: command.room_id,
      rally_id: command.rally_id,
      operation_kind: command.kind,
      result_revision: revision.toString(),
      server_sequence: receipt.serverSequence.toString(),
      effects: {
        annotation_status: 'ready',
        terminal_key_point_id: target.id,
        score_resolution: command.payload.score_resolution,
        scoring_court_side: command.payload.scoring_court_side,
      },
      resolved_anchor: null,
    })
    await tx.annotationCommandReceipt.update({
      data: { responseJson: jsonValue(response) },
      where: { serverSequence: receipt.serverSequence },
    })
    await tx.annotationOperation.create({
      data: {
        baseRevision: rally.annotationRevision,
        clientMutationId: command.command_id,
        deviceSessionId: identity.deviceSessionId,
        operationKind: command.kind,
        payload: jsonValue(command.payload),
        payloadHash: hash,
        rallyId: command.rally_id,
        receiptServerSequence: receipt.serverSequence,
        resultRevision: revision,
        userId: identity.userId,
      },
    })
    await tx.outboxEvent.create({
      data: {
        aggregateId: command.rally_id,
        aggregateType: 'Rally',
        dedupeKey: `annotation-accepted:${receipt.serverSequence}`,
        eventType: 'annotation.command_accepted.v2',
        payload: jsonValue(response),
      },
    })
    return response
  })
}

async function acceptOutcome(
  database: PrismaClient,
  room: AnnotationRoom,
  command: OutcomeCommand,
  identity: AnnotationIdentity,
  hash: string,
): Promise<AnnotationCommandResponse> {
  return serializable(database, async tx => {
    await commandLock(tx, command.command_id)
    const existing = await replay(tx, command, hash)
    if (existing) return existing
    await rallyLock(tx, command.rally_id)
    const [rally, device, authorizedMatch] = await Promise.all([
      tx.rally.findUnique({
        where: { id: command.rally_id },
        include: {
          boundaries: true,
          keyPoints: { where: { deletedAt: null } },
          operations: { orderBy: { resultRevision: 'asc' }, take: 1 },
        },
      }),
      tx.deviceSession.findUnique({
        select: { revokedAt: true, userId: true },
        where: { id: identity.deviceSessionId },
      }),
      tx.match.findFirst({
        select: { id: true },
        where: {
          id: room.matchId,
          captureSessions: { some: { id: room.captureSessionId } },
          ...(identity.role === UserRole.ADMIN
            ? {}
            : {
                members: {
                  some: {
                    userId: identity.userId,
                    role: { in: [UserRole.ADMIN, UserRole.OPERATOR, UserRole.ANNOTATOR] },
                  },
                },
              }),
        },
      }),
    ])
    if (!device || device.userId !== identity.userId || device.revokedAt)
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(command, 'UNAUTHENTICATED', 'Authenticated device session is no longer active'),
      )
    if (!authorizedMatch)
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(
          command,
          'ROOM_AUTHORIZATION_STALE',
          'Annotation room authorization changed before commit',
        ),
      )
    if (
      !rally ||
      rally.matchId !== room.matchId ||
      !['OPEN', 'READY'].includes(rally.annotationStatus)
    )
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(command, 'RALLY_NOT_OPEN', 'Rally outcome is not editable'),
      )
    if (!ordinaryDraftBelongsToDevice(rally, identity.deviceSessionId))
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(command, 'RALLY_OWNED_BY_OTHER_CLIENT', '這個片段屬於另一個標註客戶端'),
      )
    if (command.base_revision !== rally.annotationRevision.toString())
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(command, 'REVISION_CONFLICT', 'Rally revision is stale', {
          actual: rally.annotationRevision.toString(),
          expected: command.base_revision,
        }),
      )
    const revision = rally.annotationRevision + 1n
    const resolution = command.payload.score_resolution.toUpperCase() as 'RESOLVED' | 'UNKNOWN'
    const scoringCourtSide = command.payload.scoring_court_side?.toUpperCase() as
      'LEFT' | 'RIGHT' | undefined
    const cas = await tx.rally.updateMany({
      data: {
        annotationRevision: revision,
        scoreResolutionState: resolution,
        scoringCourtSide: scoringCourtSide ?? null,
        scoringTeamId: null,
      },
      where: {
        id: rally.id,
        annotationRevision: rally.annotationRevision,
        annotationStatus: { in: ['OPEN', 'READY'] },
      },
    })
    if (cas.count !== 1)
      throw new Prisma.PrismaClientKnownRequestError('Rally changed concurrently', {
        code: 'P2034',
        clientVersion: 'annotation-v3',
      })
    const receipt = await tx.annotationCommandReceipt.create({
      data: {
        accepted: true,
        commandId: command.command_id,
        deviceSessionId: identity.deviceSessionId,
        rallyId: command.rally_id,
        requestHash: hash,
        requestJson: jsonValue(command),
        responseJson: {},
        roomId: command.room_id,
        userId: identity.userId,
      },
    })
    const response = parseAnnotationCommandResponse({
      schema_version: '3.0.0',
      type: 'command_ack',
      command_id: command.command_id,
      room_id: command.room_id,
      rally_id: command.rally_id,
      operation_kind: command.kind,
      result_revision: revision.toString(),
      server_sequence: receipt.serverSequence.toString(),
      effects: {
        annotation_status: rally.annotationStatus.toLowerCase(),
        score_resolution: command.payload.score_resolution,
        scoring_court_side: command.payload.scoring_court_side,
      },
    })
    await tx.annotationCommandReceipt.update({
      data: { responseJson: jsonValue(response) },
      where: { serverSequence: receipt.serverSequence },
    })
    await tx.annotationOperation.create({
      data: {
        baseRevision: rally.annotationRevision,
        clientMutationId: command.command_id,
        deviceSessionId: identity.deviceSessionId,
        operationKind: command.kind,
        payload: jsonValue(command.payload),
        payloadHash: hash,
        rallyId: command.rally_id,
        receiptServerSequence: receipt.serverSequence,
        resultRevision: revision,
        userId: identity.userId,
      },
    })
    await tx.outboxEvent.create({
      data: {
        aggregateId: command.rally_id,
        aggregateType: 'Rally',
        dedupeKey: `annotation-accepted:${receipt.serverSequence}`,
        eventType: 'annotation.command_accepted.v3',
        payload: jsonValue(response),
      },
    })
    return response
  })
}

async function clipRangeOverlapsExistingRally(
  tx: Transaction,
  matchId: string,
  proposedStart: bigint,
  proposedEnd: bigint,
  clipPreRollUs: bigint,
  clipPostRollUs: bigint,
  excludedRallyId?: string,
) {
  const existingSegments = await tx.rally.findMany({
    where: {
      matchId,
      voidedAt: null,
      ...(excludedRallyId ? { id: { not: excludedRallyId } } : {}),
    },
    select: {
      annotationStatus: true,
      activeSubmission: {
        select: {
          boundaries: { orderBy: { captureTimeUs: 'asc' }, select: { captureTimeUs: true } },
          clipPostRollUs: true,
          clipPreRollUs: true,
          clipJobs: {
            orderBy: { createdAt: 'desc' },
            select: {
              actualEndCaptureUs: true,
              actualStartCaptureUs: true,
              requestedEndCaptureUs: true,
              requestedStartCaptureUs: true,
            },
            take: 1,
          },
          keyPoints: { orderBy: { sequenceIndex: 'asc' }, select: { captureTimeUs: true } },
        },
      },
      boundaries: { orderBy: { captureTimeUs: 'asc' }, select: { captureTimeUs: true } },
      keyPoints: {
        orderBy: { sequenceIndex: 'asc' },
        select: { captureTimeUs: true },
        where: { deletedAt: null },
      },
    },
  })
  return existingSegments.some(segment => {
    // Other clients may keep overlapping editable drafts. Only the active,
    // immutable submission is a canonical clip conflict. Keep the fallback for
    // legacy non-editable rows created before activeSubmissionId was mandatory.
    const immutable = segment.activeSubmission
    if (!immutable && (segment.annotationStatus === 'OPEN' || segment.annotationStatus === 'READY'))
      return false
    const clip = immutable?.clipJobs[0]
    const points = immutable
      ? [...immutable.boundaries, ...immutable.keyPoints]
      : [...segment.boundaries, ...segment.keyPoints]
    points.sort((left, right) =>
      left.captureTimeUs < right.captureTimeUs
        ? -1
        : left.captureTimeUs > right.captureTimeUs
          ? 1
          : 0,
    )
    const first = points[0]
    const last = points.at(-1)
    if (!first || !last) return false
    const paddingBefore = immutable?.clipPreRollUs ?? clipPreRollUs
    const paddingAfter = immutable?.clipPostRollUs ?? clipPostRollUs
    const paddedStart = first.captureTimeUs - paddingBefore
    const start = clip
      ? (clip.actualStartCaptureUs ?? clip.requestedStartCaptureUs)
      : paddedStart < 0n
        ? 0n
        : paddedStart
    const end = clip
      ? (clip.actualEndCaptureUs ?? clip.requestedEndCaptureUs)
      : last.captureTimeUs + paddingAfter
    return proposedStart < end && proposedEnd > start
  })
}

async function acceptDraftEdit(
  database: PrismaClient,
  room: AnnotationRoom,
  command: EditCommand,
  identity: AnnotationIdentity,
  hash: string,
  anchor?: ResolvedMediaAnchor,
): Promise<AnnotationCommandResponse> {
  return serializable(database, async tx => {
    await commandLock(tx, command.command_id)
    const existing = await replay(tx, command, hash)
    if (existing) return existing
    await rallyLock(tx, command.rally_id)
    const rally = await tx.rally.findUnique({
      where: { id: command.rally_id },
      include: {
        boundaries: true,
        keyPoints: { where: { deletedAt: null }, orderBy: { sequenceIndex: 'asc' } },
        operations: { orderBy: { resultRevision: 'asc' }, take: 1 },
      },
    })
    const device = await tx.deviceSession.findUnique({
      select: { revokedAt: true, userId: true },
      where: { id: identity.deviceSessionId },
    })
    if (!device || device.userId !== identity.userId || device.revokedAt)
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(command, 'UNAUTHENTICATED', 'Authenticated device session is no longer active'),
      )
    const authorizedMatch = await tx.match.findFirst({
      select: { clipPostRollUs: true, clipPreRollUs: true, id: true },
      where: {
        id: room.matchId,
        captureSessions: { some: { id: room.captureSessionId } },
        ...(identity.role === UserRole.ADMIN
          ? {}
          : {
              members: {
                some: {
                  userId: identity.userId,
                  role: { in: [UserRole.ADMIN, UserRole.OPERATOR, UserRole.ANNOTATOR] },
                },
              },
            }),
      },
    })
    if (!authorizedMatch || !rally || rally.matchId !== room.matchId)
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(command, 'ROOM_AUTHORIZATION_STALE', 'Rally authorization changed before commit'),
      )
    if (!ordinaryDraftBelongsToDevice(rally, identity.deviceSessionId))
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(command, 'RALLY_OWNED_BY_OTHER_CLIENT', '這個片段屬於另一個標註客戶端'),
      )
    await setAllocationLock(tx, rally.setId)
    if (rally.annotationRevision.toString() !== command.base_revision)
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(command, 'REVISION_CONFLICT', 'Rally revision is stale', {
          actual: rally.annotationRevision.toString(),
          expected: command.base_revision,
        }),
      )
    if (rally.annotationStatus === 'SUBMITTED' || rally.annotationStatus === 'VOIDED')
      return persistRejection(
        tx,
        command,
        identity,
        hash,
        rejected(
          command,
          'IMMUTABLE_SUBMISSION',
          'Submitted or voided Rally cannot be edited in place',
        ),
      )
    const revision = rally.annotationRevision + 1n
    let effects: Record<string, unknown>
    if (command.kind === 'REOPEN_RALLY') {
      const isCorrection = rally.activeSubmissionId !== null
      if (
        rally.annotationStatus !== 'READY' &&
        !(isCorrection && rally.annotationStatus === 'OPEN')
      )
        return persistRejection(
          tx,
          command,
          identity,
          hash,
          rejected(
            command,
            'RALLY_NOT_READY',
            'Only a READY Rally or an open correction draft can be reopened',
          ),
        )
      if (!isCorrection) {
        const competing = await tx.rally.findFirst({
          where: {
            activeSubmissionId: null,
            id: { not: rally.id },
            matchId: rally.matchId,
            annotationStatus: 'OPEN',
            voidedAt: null,
            OR: [
              {
                boundaries: { some: { deviceSessionId: identity.deviceSessionId, kind: 'START' } },
              },
              {
                keyPoints: {
                  some: { deviceSessionId: identity.deviceSessionId, markerKind: 'SERVICE' },
                },
              },
            ],
          },
          select: { id: true },
        })
        if (competing)
          return persistRejection(
            tx,
            command,
            identity,
            hash,
            rejected(
              command,
              'ACTIVE_RALLY_EXISTS',
              'Close or void the open Rally before reopening another draft',
            ),
          )
      }
      if (!isCorrection) {
        await tx.keyPoint.updateMany({
          where: { rallyId: rally.id, deletedAt: null, isTerminal: true },
          data: { isTerminal: false, updatedByUserId: identity.userId },
        })
        await tx.rallyBoundary.deleteMany({ where: { rallyId: rally.id, kind: 'END' } })
      }
      await tx.rally.update({
        where: { id: rally.id },
        data: isCorrection
          ? { annotationRevision: revision, annotationStatus: 'OPEN' }
          : {
              annotationRevision: revision,
              annotationStatus: 'OPEN',
              scoreResolutionState: 'PENDING',
              scoringCourtSide: null,
              scoringTeamId: null,
            },
      })
      effects = isCorrection
        ? {
            annotation_status: 'open',
            score_resolution: rally.scoreResolutionState.toLowerCase(),
            scoring_court_side: rally.scoringCourtSide?.toLowerCase() ?? null,
          }
        : { annotation_status: 'open', score_resolution: 'pending', scoring_court_side: null }
    } else if (command.kind === 'VOID_RALLY') {
      await tx.rally.update({
        where: { id: rally.id },
        data: { annotationRevision: revision, annotationStatus: 'VOIDED', voidedAt: new Date() },
      })
      effects = { annotation_status: 'voided' }
    } else if (command.kind === 'DELETE_KEY_POINT') {
      if (!['OPEN', 'READY'].includes(rally.annotationStatus))
        return persistRejection(
          tx,
          command,
          identity,
          hash,
          rejected(command, 'RALLY_NOT_OPEN', 'Rally is not editable'),
        )
      const target = rally.keyPoints.find(point => point.id === command.payload.key_point_id)
      if (!target || target.markerKind === 'SERVICE')
        return persistRejection(
          tx,
          command,
          identity,
          hash,
          rejected(command, 'KEY_POINT_NOT_EDITABLE', 'The service anchor cannot be deleted'),
        )
      await tx.keyPoint.update({
        where: { id: target.id },
        data: {
          deletedAt: new Date(),
          sequenceIndex: await nextTombstoneSequence(tx, rally.id),
          updatedByUserId: identity.userId,
        },
      })
      const active = rally.keyPoints.filter(point => point.id !== target.id)
      await rewriteActiveSequence(tx, rally.id, active)
      const remaining = active.filter(point => point.markerKind === 'CONTACT')
      for (const point of remaining)
        await tx.keyPoint.update({
          where: { id: point.id },
          data: {
            possibleDuplicate:
              remaining.filter(other => other.captureFrameIndex === point.captureFrameIndex)
                .length > 1,
          },
        })
      await tx.rally.update({ where: { id: rally.id }, data: { annotationRevision: revision } })
      effects = {
        annotation_status: rally.annotationStatus.toLowerCase(),
        deleted_key_point_id: target.id,
        score_resolution: rally.scoreResolutionState.toLowerCase(),
        scoring_court_side: rally.scoringCourtSide?.toLowerCase() ?? null,
      }
    } else {
      if (!['OPEN', 'READY'].includes(rally.annotationStatus) || !anchor)
        return persistRejection(
          tx,
          command,
          identity,
          hash,
          rejected(command, 'RALLY_NOT_OPEN', 'Rally is not editable'),
        )
      const target = rally.keyPoints.find(point => point.id === command.payload.key_point_id)
      if (!target)
        return persistRejection(
          tx,
          command,
          identity,
          hash,
          rejected(command, 'KEY_POINT_NOT_FOUND', 'Key point was not found'),
        )
      const mapping = anchor.dvr_segment_id
        ? await tx.playbackWindow.findFirst({
            where: {
              id: anchor.playback_window_id,
              captureSessionId: room.captureSessionId,
              mappingVersion: anchor.mapping_version,
              dvrProgramId: rally.dvrProgramId,
              segments: {
                some: {
                  dvrSegment: {
                    id: anchor.dvr_segment_id,
                    captureEpochId: anchor.capture_epoch_id,
                    dvrProgramId: rally.dvrProgramId,
                    isGap: false,
                    readyAt: { not: null },
                    sampleIndexAssetId: { not: null },
                  },
                },
              },
            },
            select: { captureStartUs: true, captureEndUs: true, presentationOriginCaptureUs: true },
          })
        : null
      const resolvedTime = BigInt(anchor.capture_time_us)
      const resolvedFrame = BigInt(anchor.capture_frame_index)
      const playerTime = BigInt(anchor.resolved_player_media_time_us)
      if (
        !mapping ||
        resolvedTime < mapping.captureStartUs ||
        resolvedTime >= mapping.captureEndUs ||
        playerTime !== resolvedTime - mapping.presentationOriginCaptureUs ||
        anchor.playback_window_id !== command.payload.playback_cursor.playback_window_id ||
        anchor.mapping_version !== command.payload.playback_cursor.mapping_version
      )
        return persistRejection(
          tx,
          command,
          identity,
          hash,
          rejected(command, 'ANNOTATION_NOT_READY', 'Resolved playback state is no longer valid'),
        )
      const isBoundaryDraft = rally.boundaries.some(boundary => boundary.kind === 'START')
      if (!isBoundaryDraft) {
        const service = rally.keyPoints.find(point => point.markerKind === 'SERVICE')
        if (
          (target.markerKind === 'CONTACT' && service && resolvedTime < service.captureTimeUs) ||
          (target.markerKind === 'SERVICE' &&
            rally.keyPoints.some(
              point => point.markerKind === 'CONTACT' && resolvedTime > point.captureTimeUs,
            ))
        )
          return persistRejection(
            tx,
            command,
            identity,
            hash,
            rejected(
              command,
              'ANNOTATION_NOT_READY',
              'Moved point would violate service-first ordering',
            ),
          )
        const proposedTimes = rally.keyPoints
          .map(point => (point.id === target.id ? resolvedTime : point.captureTimeUs))
          .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
        const paddedStart = proposedTimes[0]! - authorizedMatch.clipPreRollUs
        const proposedStart = paddedStart < 0n ? 0n : paddedStart
        const proposedEnd = proposedTimes.at(-1)! + authorizedMatch.clipPostRollUs
        if (
          await clipRangeOverlapsExistingRally(
            tx,
            room.matchId,
            proposedStart,
            proposedEnd,
            authorizedMatch.clipPreRollUs,
            authorizedMatch.clipPostRollUs,
            rally.id,
          )
        ) {
          return persistRejection(
            tx,
            command,
            identity,
            hash,
            rejected(
              command,
              'ANNOTATION_NOT_READY',
              'Moving the key point would overlap another Rally clip',
            ),
          )
        }
      }
      await tx.keyPoint.update({
        where: { id: target.id },
        data: {
          captureEpochId: anchor.capture_epoch_id,
          captureFrameIndex: resolvedFrame,
          captureTimeUs: resolvedTime,
          sourcePts: BigInt(anchor.source_pts),
          timingPrecision: anchor.timing_precision.toUpperCase() as
            'FRAME_EXACT' | 'PTS_EXACT' | 'ESTIMATED',
          snapDistanceUs: anchor.snap_distance_us == null ? null : BigInt(anchor.snap_distance_us),
          originalPlaybackCursor: jsonValue(command.payload.playback_cursor),
          updatedByUserId: identity.userId,
        },
      })
      const ordered = rally.keyPoints
        .map(point =>
          point.id === target.id
            ? { ...point, captureTimeUs: resolvedTime, captureFrameIndex: resolvedFrame }
            : point,
        )
        .sort((left, right) =>
          !isBoundaryDraft && left.markerKind === 'SERVICE'
            ? -1
            : !isBoundaryDraft && right.markerKind === 'SERVICE'
              ? 1
              : left.captureTimeUs < right.captureTimeUs
                ? -1
                : left.captureTimeUs > right.captureTimeUs
                  ? 1
                  : left.captureFrameIndex < right.captureFrameIndex
                    ? -1
                    : 1,
        )
      await rewriteActiveSequence(tx, rally.id, ordered)
      for (const point of ordered)
        await tx.keyPoint.update({
          where: { id: point.id },
          data: {
            possibleDuplicate:
              point.markerKind === 'CONTACT' &&
              ordered.filter(
                other =>
                  other.markerKind === 'CONTACT' &&
                  other.captureFrameIndex === point.captureFrameIndex,
              ).length > 1,
          },
        })
      await tx.rally.update({ where: { id: rally.id }, data: { annotationRevision: revision } })
      effects = {
        annotation_status: rally.annotationStatus.toLowerCase(),
        score_resolution: rally.scoreResolutionState.toLowerCase(),
        scoring_court_side: rally.scoringCourtSide?.toLowerCase() ?? null,
      }
    }
    const receipt = await tx.annotationCommandReceipt.create({
      data: {
        accepted: true,
        commandId: command.command_id,
        deviceSessionId: identity.deviceSessionId,
        rallyId: command.rally_id,
        requestHash: hash,
        requestJson: jsonValue(command),
        responseJson: {},
        roomId: command.room_id,
        userId: identity.userId,
      },
    })
    const response = parseAnnotationCommandResponse({
      schema_version: command.schema_version,
      type: 'command_ack',
      command_id: command.command_id,
      room_id: command.room_id,
      rally_id: command.rally_id,
      operation_kind: command.kind,
      result_revision: revision.toString(),
      server_sequence: receipt.serverSequence.toString(),
      effects,
      resolved_anchor: anchor ? wireAnchor(anchor) : null,
    })
    await tx.annotationCommandReceipt.update({
      data: { responseJson: jsonValue(response) },
      where: { serverSequence: receipt.serverSequence },
    })
    await tx.annotationOperation.create({
      data: {
        baseRevision: rally.annotationRevision,
        clientMutationId: command.command_id,
        deviceSessionId: identity.deviceSessionId,
        operationKind: command.kind,
        payload: jsonValue(command.payload),
        payloadHash: hash,
        rallyId: command.rally_id,
        receiptServerSequence: receipt.serverSequence,
        resultRevision: revision,
        userId: identity.userId,
      },
    })
    await tx.outboxEvent.create({
      data: {
        aggregateId: command.rally_id,
        aggregateType: 'Rally',
        dedupeKey: `annotation-accepted:${receipt.serverSequence}`,
        eventType: `annotation.command_accepted.v${command.schema_version.startsWith('3.') ? '3' : '2'}`,
        payload: jsonValue(response),
      },
    })
    return response
  })
}

export function createAnnotationCommandService(
  deps: AnnotationCommandServiceDependencies,
): AnnotationCommandService {
  return {
    authorizeRoom: (roomId, identity) => authorizeAnnotationRoom(deps.database, roomId, identity),
    async roomSequence(roomId) {
      const aggregate = await deps.database.annotationCommandReceipt.aggregate({
        _max: { serverSequence: true },
        where: { roomId },
      })
      return aggregate._max.serverSequence ?? 0n
    },
    async apply(command, identity) {
      const hash = requestHash(command)
      const device = await deps.database.deviceSession.findFirst({
        select: { id: true },
        where: { id: identity.deviceSessionId, revokedAt: null, userId: identity.userId },
      })
      if (!device) {
        throw new TypeError('Authenticated device session is not active')
      }
      const room = await authorizeAnnotationRoom(deps.database, command.room_id, identity)
      if (!room) {
        return storeRejection(
          deps.database,
          command,
          identity,
          hash,
          rejected(command, 'ROOM_NOT_FOUND', 'Annotation room not found'),
        )
      }
      const prior = await replay(deps.database, command, hash)
      if (prior) return prior
      await deps.beforeTransaction?.(command)
      if (command.kind === 'SUBMIT_RALLY') {
        return serializable(deps.database, async tx => {
          await commandLock(tx, command.command_id)
          const existing = await replay(tx, command, hash)
          if (existing) return existing
          await rallyLock(tx, command.rally_id)
          return submitRally(tx, room, command, identity, hash)
        })
      }
      if (command.kind === 'CREATE_CONTACT_KEY_POINT' || command.kind === 'END_RALLY') {
        if (command.base_revision === '0')
          return storeRejection(
            deps.database,
            command,
            identity,
            hash,
            rejected(
              command,
              'REVISION_CONFLICT',
              'Contact command cannot start at revision zero',
              { actual: '1', expected: '0' },
            ),
          )
        let anchor: ResolvedMediaAnchor
        try {
          anchor = await deps.resolveCursor(toMediaCursor(command), {
            id: identity.userId,
            role: identity.role,
          })
        } catch (error) {
          if (!(error instanceof MediaHttpError)) throw error
          return storeRejection(
            deps.database,
            command,
            identity,
            hash,
            mediaRejection(command, error),
          )
        }
        return acceptContact(deps.database, room, command, identity, hash, anchor)
      }
      if (command.kind === 'CLOSE_RALLY')
        return acceptClose(deps.database, room, command, identity, hash)
      if (command.kind === 'SET_RALLY_OUTCOME')
        return acceptOutcome(deps.database, room, command, identity, hash)
      if (command.kind === 'MOVE_KEY_POINT') {
        let anchor: ResolvedMediaAnchor
        try {
          anchor = await deps.resolveCursor(
            toMediaCursor(command as unknown as CreateServiceKeyPointCommand),
            { id: identity.userId, role: identity.role },
          )
        } catch (error) {
          if (!(error instanceof MediaHttpError)) throw error
          return storeRejection(
            deps.database,
            command,
            identity,
            hash,
            mediaRejection(command, error),
          )
        }
        return acceptDraftEdit(deps.database, room, command, identity, hash, anchor)
      }
      if (
        command.kind === 'DELETE_KEY_POINT' ||
        command.kind === 'REOPEN_RALLY' ||
        command.kind === 'VOID_RALLY'
      )
        return acceptDraftEdit(deps.database, room, command, identity, hash)
      if (command.kind !== 'CREATE_SERVICE_KEY_POINT' && command.kind !== 'START_RALLY')
        return storeRejection(
          deps.database,
          command,
          identity,
          hash,
          rejected(command, 'UNSUPPORTED_COMMAND', 'Command is not durable in this server slice'),
        )
      if (command.base_revision !== '0') {
        return storeRejection(
          deps.database,
          command,
          identity,
          hash,
          rejected(command, 'REVISION_CONFLICT', 'Service command must start at revision zero', {
            actual: '0',
            expected: command.base_revision,
          }),
        )
      }
      let anchor: ResolvedMediaAnchor
      try {
        anchor = await deps.resolveCursor(toMediaCursor(command), {
          id: identity.userId,
          role: identity.role,
        })
      } catch (error) {
        if (!(error instanceof MediaHttpError)) throw error
        return storeRejection(
          deps.database,
          command,
          identity,
          hash,
          mediaRejection(command, error),
        )
      }
      return acceptService(deps.database, room, command, identity, hash, anchor)
    },
  }
}

export { type AnnotationIdentity }
