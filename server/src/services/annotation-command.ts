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

const SERIALIZABLE_RETRIES = 3

export interface AnnotationCommandServiceDependencies {
  database: PrismaClient
  resolveCursor: (
    cursor: PlaybackCursor,
    identity: CursorMediaIdentity,
  ) => Promise<ResolvedMediaAnchor>
}

export interface AnnotationCommandService {
  apply(command: AnnotationCommand, identity: AnnotationIdentity): Promise<AnnotationCommandResponse>
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
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
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
    schema_version: '2.0.0',
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
    snapshot_refetch_required: code === 'REVISION_CONFLICT' || code === 'CLOSE_RALLY_TARGET_NOT_LAST',
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

function toMediaCursor(command: CreateServiceKeyPointCommand): PlaybackCursor {
  return { schema_version: '1.0.0', ...command.payload.playback_cursor }
}

function isRetryable(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034'
}

async function serializable<T>(database: PrismaClient, work: (tx: Transaction) => Promise<T>): Promise<T> {
  let failure: unknown
  for (let attempt = 0; attempt < SERIALIZABLE_RETRIES; attempt += 1) {
    try {
      return await database.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
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

async function replay(
  database: PrismaClient | Transaction,
  command: AnnotationCommand,
  hash: string,
): Promise<AnnotationCommandResponse | null> {
  const receipt = await database.annotationCommandReceipt.findUnique({ where: { commandId: command.command_id } })
  if (!receipt) return null
  if (receipt.requestHash !== hash) {
    return rejected(command, 'COMMAND_ID_REUSED', 'Command id was already used for a different request')
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
  return serializable(database, async (tx) => {
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
  const receipt = await tx.annotationCommandReceipt.create({ data: {
    accepted: false,
    commandId: command.command_id,
    deviceSessionId: identity.deviceSessionId,
    rallyId: command.rally_id,
    requestHash: hash,
    requestJson: jsonValue(command),
    responseJson: jsonValue(response),
    roomId: command.room_id,
    userId: identity.userId,
  } })
  await tx.outboxEvent.create({ data: {
    aggregateId: command.rally_id,
    aggregateType: 'AnnotationCommandReceipt',
    dedupeKey: `annotation-rejected:${receipt.serverSequence}`,
    eventType: 'annotation.command_rejected.v2',
    payload: jsonValue(response),
  } })
  const stored = parseAnnotationCommandResponse(receipt.responseJson)
  if (stored.type !== 'command_rejected') throw new TypeError('Stored rejection is invalid')
  return stored
}

function mediaRejection(command: AnnotationCommand, error: MediaHttpError): AnnotationCommandRejected {
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
  command: CreateServiceKeyPointCommand,
  identity: AnnotationIdentity,
  hash: string,
  anchor: ResolvedMediaAnchor,
): Promise<AnnotationCommandResponse> {
  return serializable(database, async (tx) => {
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
        select: { id: true },
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
      return persistRejection(tx, command, identity, hash, rejected(
        command,
        'UNAUTHENTICATED',
        'Authenticated device session is no longer active',
      ))
    }
    if (!authorizedMatch) {
      return persistRejection(tx, command, identity, hash, rejected(
        command,
        'ROOM_AUTHORIZATION_STALE',
        'Annotation room authorization changed before commit',
      ))
    }

    const conflicting = await tx.rally.findUnique({ select: { annotationRevision: true }, where: { id: command.rally_id } })
    if (conflicting) {
      const response = rejected(command, 'REVISION_CONFLICT', 'Rally already exists', {
        actual: conflicting.annotationRevision.toString(),
        expected: '0',
      })
      return persistRejection(tx, command, identity, hash, response)
    }

    const segmentId = anchor.dvr_segment_id
    const playbackWindowPromise = segmentId === null || segmentId === undefined
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
    const mappedSegment = segmentId === null || segmentId === undefined
      ? null
      : playbackWindow?.segments[0]?.dvrSegment ?? null
    const captureTimeUs = BigInt(anchor.capture_time_us)
    const captureFrameIndex = BigInt(anchor.capture_frame_index)
    const resolvedPlayerMediaTimeUs = BigInt(anchor.resolved_player_media_time_us)
    const segmentContainsFrame = mappedSegment?.firstFrameIndex !== null
      && mappedSegment?.firstFrameIndex !== undefined
      && captureFrameIndex >= mappedSegment.firstFrameIndex
      && captureFrameIndex < mappedSegment.firstFrameIndex + mappedSegment.frameCount
    if (
      !playbackWindow
      || !set
      || !epoch
      || !mappedSegment
      || anchor.capture_session_id !== room.captureSessionId
      || playbackWindow.mappingVersion !== anchor.mapping_version
      || command.payload.playback_cursor.playback_window_id !== anchor.playback_window_id
      || command.payload.playback_cursor.mapping_version !== anchor.mapping_version
      || mappedSegment.id !== segmentId
      || mappedSegment.dvrProgramId !== playbackWindow.dvrProgramId
      || mappedSegment.captureEpochId !== anchor.capture_epoch_id
      || mappedSegment.isGap
      || mappedSegment.readyAt === null
      || mappedSegment.sampleIndexAssetId === null
      || captureTimeUs < playbackWindow.captureStartUs
      || captureTimeUs >= playbackWindow.captureEndUs
      || captureTimeUs < mappedSegment.captureStartUs
      || captureTimeUs >= mappedSegment.captureEndUs
      || !segmentContainsFrame
      || resolvedPlayerMediaTimeUs !== captureTimeUs - playbackWindow.presentationOriginCaptureUs
    ) {
      return persistRejection(tx, command, identity, hash, rejected(
        command,
        'ANNOTATION_NOT_READY',
        'Resolved playback state is no longer valid',
      ))
    }

    await setAllocationLock(tx, set.id)
    const activeDraft = await tx.rally.findFirst({
      select: { id: true },
      where: { annotationStatus: { in: ['OPEN', 'READY'] }, setId: set.id },
    })
    if (activeDraft) {
      return persistRejection(tx, command, identity, hash, rejected(
        command,
        'ACTIVE_RALLY_EXISTS',
        'The current set already has an editable rally draft',
      ))
    }
    const aggregate = await tx.rally.aggregate({ _max: { ordinal: true }, where: { setId: set.id } })
    const ordinal = (aggregate._max.ordinal ?? 0) + 1
    const assignment = await tx.courtSideAssignment.findFirst({
      orderBy: { effectiveFromRallyOrdinal: 'desc' },
      where: {
        effectiveFromRallyOrdinal: { lte: ordinal },
        OR: [{ effectiveToRallyOrdinal: null }, { effectiveToRallyOrdinal: { gte: ordinal } }],
        setId: set.id,
      },
    })
    if (!assignment) {
      return persistRejection(tx, command, identity, hash, rejected(
        command,
        'ANNOTATION_NOT_READY',
        'Court-side assignment is not ready',
      ))
    }

    const keyPointId = randomUUID()
    await tx.rally.create({ data: {
      annotationRevision: 1n,
      dvrProgramId: playbackWindow.dvrProgramId,
      id: command.rally_id,
      matchId: room.matchId,
      ordinal,
      setId: set.id,
      sideAssignmentId: assignment.id,
    } })
    await tx.keyPoint.create({ data: {
      captureEpochId: anchor.capture_epoch_id,
      captureFrameIndex: BigInt(anchor.capture_frame_index),
      captureTimeUs: BigInt(anchor.capture_time_us),
      createdByUserId: identity.userId,
      deviceSessionId: identity.deviceSessionId,
      id: keyPointId,
      markerKind: 'SERVICE',
      originalPlaybackCursor: jsonValue(command.payload.playback_cursor),
      rallyId: command.rally_id,
      sequenceIndex: 0,
      snapDistanceUs: anchor.snap_distance_us == null ? null : BigInt(anchor.snap_distance_us),
      sourcePts: BigInt(anchor.source_pts),
      timingPrecision: anchor.timing_precision.toUpperCase() as 'FRAME_EXACT' | 'PTS_EXACT' | 'ESTIMATED',
      updatedByUserId: identity.userId,
    } })

    const receipt = await tx.annotationCommandReceipt.create({ data: {
      accepted: true,
      commandId: command.command_id,
      deviceSessionId: identity.deviceSessionId,
      rallyId: command.rally_id,
      requestHash: hash,
      requestJson: jsonValue(command),
      responseJson: {},
      roomId: command.room_id,
      userId: identity.userId,
    } })
    const response = parseAnnotationCommandResponse({
      schema_version: '2.0.0',
      type: 'command_ack',
      command_id: command.command_id,
      room_id: command.room_id,
      rally_id: command.rally_id,
      operation_kind: command.kind,
      result_revision: '1',
      server_sequence: receipt.serverSequence.toString(),
      effects: {
        annotation_status: 'open',
        created_key_point_id: keyPointId,
        score_resolution: 'pending',
        scoring_court_side: null,
      },
      resolved_anchor: wireAnchor(anchor),
    })
    const storedReceipt = await tx.annotationCommandReceipt.update({
      data: { responseJson: jsonValue(response) },
      select: { responseJson: true },
      where: { serverSequence: receipt.serverSequence },
    })
    await tx.annotationOperation.create({ data: {
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
    } })
    await tx.outboxEvent.create({ data: {
      aggregateId: command.rally_id,
      aggregateType: 'Rally',
      dedupeKey: `annotation-accepted:${receipt.serverSequence}`,
      eventType: 'annotation.command_accepted.v2',
      payload: jsonValue(response),
    } })
    const stored = parseAnnotationCommandResponse(storedReceipt.responseJson)
    if (stored.type !== 'command_ack') throw new TypeError('Stored acknowledgement is invalid')
    return stored
  })
}

type ContactCommand = Extract<AnnotationCommand, { kind: 'CREATE_CONTACT_KEY_POINT' }>
type CloseCommand = Extract<AnnotationCommand, { kind: 'CLOSE_RALLY' }>

async function acceptContact(database: PrismaClient, room: AnnotationRoom, command: ContactCommand, identity: AnnotationIdentity, hash: string, anchor: ResolvedMediaAnchor): Promise<AnnotationCommandResponse> {
  return serializable(database, async (tx) => {
    await commandLock(tx, command.command_id)
    const existing = await replay(tx, command, hash)
    if (existing) return existing
    await rallyLock(tx, command.rally_id)
    const rally = await tx.rally.findUnique({ where: { id: command.rally_id }, include: { keyPoints: { where: { deletedAt: null }, orderBy: { sequenceIndex: 'desc' }, take: 1 } } })
    const device = await tx.deviceSession.findUnique({ select: { revokedAt: true, userId: true }, where: { id: identity.deviceSessionId } })
    if (!device || device.userId !== identity.userId || device.revokedAt) return persistRejection(tx, command, identity, hash, rejected(command, 'UNAUTHENTICATED', 'Authenticated device session is no longer active'))
    const authorizedMatch = await tx.match.findFirst({ select: { id: true }, where: { id: room.matchId, captureSessions: { some: { id: room.captureSessionId } }, ...(identity.role === UserRole.ADMIN ? {} : { members: { some: { userId: identity.userId, role: { in: [UserRole.ADMIN, UserRole.OPERATOR, UserRole.ANNOTATOR] } } } }) } })
    if (!authorizedMatch) return persistRejection(tx, command, identity, hash, rejected(command, 'ROOM_AUTHORIZATION_STALE', 'Annotation room authorization changed before commit'))
    if (!rally || rally.matchId !== room.matchId || rally.annotationStatus !== 'OPEN') return persistRejection(tx, command, identity, hash, rejected(command, 'RALLY_NOT_OPEN', 'Rally is not an open draft'))
    await setAllocationLock(tx, rally.setId)
    if (command.base_revision !== rally.annotationRevision.toString()) return persistRejection(tx, command, identity, hash, rejected(command, 'REVISION_CONFLICT', 'Rally revision is stale', { actual: rally.annotationRevision.toString(), expected: command.base_revision }))
    const mapping = await tx.playbackWindow.findFirst({ where: { id: anchor.playback_window_id, captureSessionId: room.captureSessionId, mappingVersion: anchor.mapping_version, ...(anchor.dvr_segment_id ? { segments: { some: { dvrSegment: { id: anchor.dvr_segment_id, captureEpochId: anchor.capture_epoch_id, dvrProgramId: rally.dvrProgramId, isGap: false, readyAt: { not: null }, sampleIndexAssetId: { not: null } } } } } : {}) } })
    const epoch = await tx.captureEpoch.findFirst({ where: { id: anchor.capture_epoch_id, captureSessionId: room.captureSessionId } })
    if (anchor.capture_session_id !== room.captureSessionId || !mapping || !epoch || anchor.playback_window_id !== command.payload.playback_cursor.playback_window_id || anchor.mapping_version !== command.payload.playback_cursor.mapping_version) return persistRejection(tx, command, identity, hash, rejected(command, 'ANNOTATION_NOT_READY', 'Resolved playback state is no longer valid'))
    const allPoints = await tx.keyPoint.findMany({ where: { rallyId: command.rally_id, deletedAt: null }, orderBy: [{ captureTimeUs: 'asc' }, { captureFrameIndex: 'asc' }, { sequenceIndex: 'asc' }] })
    const captureTime = BigInt(anchor.capture_time_us)
    const captureFrame = BigInt(anchor.capture_frame_index)
    const foundIndex = allPoints.findIndex((point) => point.sequenceIndex > 0 && (point.captureTimeUs > captureTime || (point.captureTimeUs === captureTime && point.captureFrameIndex > captureFrame)))
    const insertion = foundIndex >= 0 ? Math.max(1, foundIndex) : allPoints.length
    for (const point of allPoints.filter((point) => point.sequenceIndex >= insertion).sort((a, b) => b.sequenceIndex - a.sequenceIndex)) await tx.keyPoint.update({ data: { sequenceIndex: { increment: 1 } }, where: { id: point.id } })
    const equals = allPoints.filter((point) => point.markerKind === 'CONTACT' && point.captureFrameIndex === captureFrame)
    const possibleDuplicate = equals.length > 0
    for (const point of equals) if (!point.possibleDuplicate) await tx.keyPoint.update({ data: { possibleDuplicate: true }, where: { id: point.id } })
    const keyPointId = randomUUID()
    const sequenceIndex = insertion
    await tx.keyPoint.create({ data: { captureEpochId: anchor.capture_epoch_id, captureFrameIndex: BigInt(anchor.capture_frame_index), captureTimeUs: BigInt(anchor.capture_time_us), createdByUserId: identity.userId, deviceSessionId: identity.deviceSessionId, id: keyPointId, markerKind: 'CONTACT', originalPlaybackCursor: jsonValue(command.payload.playback_cursor), rallyId: command.rally_id, sequenceIndex, snapDistanceUs: anchor.snap_distance_us == null ? null : BigInt(anchor.snap_distance_us), sourcePts: BigInt(anchor.source_pts), timingPrecision: anchor.timing_precision.toUpperCase() as 'FRAME_EXACT' | 'PTS_EXACT' | 'ESTIMATED', updatedByUserId: identity.userId, possibleDuplicate } })
    const revision = rally.annotationRevision + 1n
    const cas = await tx.rally.updateMany({ data: { annotationRevision: revision }, where: { id: rally.id, annotationRevision: rally.annotationRevision, annotationStatus: 'OPEN' } })
    if (cas.count !== 1) return persistRejection(tx, command, identity, hash, rejected(command, 'REVISION_CONFLICT', 'Rally revision is stale', { actual: rally.annotationRevision.toString(), expected: command.base_revision }))
    const receipt = await tx.annotationCommandReceipt.create({ data: { accepted: true, commandId: command.command_id, deviceSessionId: identity.deviceSessionId, rallyId: command.rally_id, requestHash: hash, requestJson: jsonValue(command), responseJson: {}, roomId: command.room_id, userId: identity.userId } })
    const response = parseAnnotationCommandResponse({ schema_version: '2.0.0', type: 'command_ack', command_id: command.command_id, room_id: command.room_id, rally_id: command.rally_id, operation_kind: command.kind, result_revision: revision.toString(), server_sequence: receipt.serverSequence.toString(), effects: { annotation_status: 'open', created_key_point_id: keyPointId, score_resolution: 'pending', scoring_court_side: null }, resolved_anchor: wireAnchor(anchor) })
    await tx.annotationCommandReceipt.update({ data: { responseJson: jsonValue(response) }, where: { serverSequence: receipt.serverSequence } })
    await tx.annotationOperation.create({ data: { baseRevision: rally.annotationRevision, clientMutationId: command.command_id, deviceSessionId: identity.deviceSessionId, operationKind: command.kind, payload: jsonValue(command.payload), payloadHash: hash, rallyId: command.rally_id, receiptServerSequence: receipt.serverSequence, resultRevision: revision, userId: identity.userId } })
    await tx.outboxEvent.create({ data: { aggregateId: command.rally_id, aggregateType: 'Rally', dedupeKey: `annotation-accepted:${receipt.serverSequence}`, eventType: 'annotation.command_accepted.v2', payload: jsonValue(response) } })
    return response
  })
}

async function acceptClose(database: PrismaClient, room: AnnotationRoom, command: CloseCommand, identity: AnnotationIdentity, hash: string): Promise<AnnotationCommandResponse> {
  return serializable(database, async (tx) => {
    await commandLock(tx, command.command_id); const existing = await replay(tx, command, hash); if (existing) return existing; await rallyLock(tx, command.rally_id)
    const rally = await tx.rally.findUnique({ where: { id: command.rally_id }, include: { keyPoints: { where: { deletedAt: null }, orderBy: { sequenceIndex: 'desc' }, take: 1 } } })
    const device = await tx.deviceSession.findUnique({ select: { revokedAt: true, userId: true }, where: { id: identity.deviceSessionId } })
    if (!device || device.userId !== identity.userId || device.revokedAt) return persistRejection(tx, command, identity, hash, rejected(command, 'UNAUTHENTICATED', 'Authenticated device session is no longer active'))
    if (!rally || rally.matchId !== room.matchId) return persistRejection(tx, command, identity, hash, rejected(command, 'RALLY_NOT_FOUND', 'Rally was not found'))
    await setAllocationLock(tx, rally.setId)
    if (rally.annotationStatus !== 'OPEN') return persistRejection(tx, command, identity, hash, rejected(command, 'RALLY_ALREADY_READY', 'Rally is already closed'))
    if (rally.annotationRevision.toString() !== command.base_revision) return persistRejection(tx, command, identity, hash, rejected(command, 'REVISION_CONFLICT', 'Rally revision is stale', { actual: rally.annotationRevision.toString(), expected: command.base_revision }))
    const target = rally.keyPoints[0]
    if (!target || target.id !== command.payload.target_key_point_id) return persistRejection(tx, command, identity, hash, rejected(command, 'CLOSE_RALLY_TARGET_NOT_LAST', 'Close target is not the last key point'))
    const revision = rally.annotationRevision + 1n
    const resolution = command.payload.score_resolution === 'resolved' ? 'RESOLVED' : 'UNKNOWN'
    await tx.keyPoint.update({ data: { isTerminal: true, updatedByUserId: identity.userId }, where: { id: target.id } })
    const cas = await tx.rally.updateMany({ data: { annotationRevision: revision, annotationStatus: 'READY', scoreResolutionState: resolution, scoringCourtSide: command.payload.scoring_court_side === null ? null : command.payload.scoring_court_side.toUpperCase() as 'LEFT' | 'RIGHT' }, where: { id: rally.id, annotationRevision: rally.annotationRevision, annotationStatus: 'OPEN' } })
    if (cas.count !== 1) return persistRejection(tx, command, identity, hash, rejected(command, 'REVISION_CONFLICT', 'Rally revision is stale', { actual: rally.annotationRevision.toString(), expected: command.base_revision }))
    const receipt = await tx.annotationCommandReceipt.create({ data: { accepted: true, commandId: command.command_id, deviceSessionId: identity.deviceSessionId, rallyId: command.rally_id, requestHash: hash, requestJson: jsonValue(command), responseJson: {}, roomId: command.room_id, userId: identity.userId } })
    const response = parseAnnotationCommandResponse({ schema_version: '2.0.0', type: 'command_ack', command_id: command.command_id, room_id: command.room_id, rally_id: command.rally_id, operation_kind: command.kind, result_revision: revision.toString(), server_sequence: receipt.serverSequence.toString(), effects: { annotation_status: 'ready', terminal_key_point_id: target.id, score_resolution: command.payload.score_resolution, scoring_court_side: command.payload.scoring_court_side }, resolved_anchor: null })
    await tx.annotationCommandReceipt.update({ data: { responseJson: jsonValue(response) }, where: { serverSequence: receipt.serverSequence } })
    await tx.annotationOperation.create({ data: { baseRevision: rally.annotationRevision, clientMutationId: command.command_id, deviceSessionId: identity.deviceSessionId, operationKind: command.kind, payload: jsonValue(command.payload), payloadHash: hash, rallyId: command.rally_id, receiptServerSequence: receipt.serverSequence, resultRevision: revision, userId: identity.userId } })
    await tx.outboxEvent.create({ data: { aggregateId: command.rally_id, aggregateType: 'Rally', dedupeKey: `annotation-accepted:${receipt.serverSequence}`, eventType: 'annotation.command_accepted.v2', payload: jsonValue(response) } })
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
        return storeRejection(deps.database, command, identity, hash, rejected(command, 'ROOM_NOT_FOUND', 'Annotation room not found'))
      }
      const prior = await replay(deps.database, command, hash)
      if (prior) return prior
      if (command.kind === 'CREATE_CONTACT_KEY_POINT') {
        if (command.base_revision === '0') return storeRejection(deps.database, command, identity, hash, rejected(command, 'REVISION_CONFLICT', 'Contact command cannot start at revision zero', { actual: '1', expected: '0' }))
        let anchor: ResolvedMediaAnchor
        try { anchor = await deps.resolveCursor(toMediaCursor(command as unknown as CreateServiceKeyPointCommand), { id: identity.userId, role: identity.role }) } catch (error) { if (!(error instanceof MediaHttpError)) throw error; return storeRejection(deps.database, command, identity, hash, mediaRejection(command, error)) }
        return acceptContact(deps.database, room, command, identity, hash, anchor)
      }
      if (command.kind === 'CLOSE_RALLY') return acceptClose(deps.database, room, command, identity, hash)
      if (command.kind !== 'CREATE_SERVICE_KEY_POINT') return storeRejection(deps.database, command, identity, hash, rejected(command, 'UNSUPPORTED_COMMAND', 'Command is not durable in this server slice'))
      if (command.base_revision !== '0') {
        return storeRejection(deps.database, command, identity, hash, rejected(command, 'REVISION_CONFLICT', 'Service command must start at revision zero', {
          actual: '0', expected: command.base_revision,
        }))
      }
      let anchor: ResolvedMediaAnchor
      try {
        anchor = await deps.resolveCursor(toMediaCursor(command), { id: identity.userId, role: identity.role })
      } catch (error) {
        if (!(error instanceof MediaHttpError)) throw error
        return storeRejection(deps.database, command, identity, hash, mediaRejection(command, error))
      }
      return acceptService(deps.database, room, command, identity, hash, anchor)
    },
  }
}

export { type AnnotationIdentity }
