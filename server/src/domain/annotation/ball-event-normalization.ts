import {
  normalizeBallEventKeyPoints,
  type BallEventRepair,
  type BallEventValue,
} from '@volleyball-monitoring/contracts'
import { Prisma } from '@volleyball-monitoring/db/client'

type Transaction = Prisma.TransactionClient

function wireEvent(event: { kind: string; result: string | null } | null): BallEventValue | null {
  if (!event) return null
  return event as BallEventValue
}

export async function normalizeDraftBallEvents(
  tx: Transaction,
  rallyId: string,
  updatedByUserId: string,
): Promise<BallEventRepair[]> {
  const rally = await tx.rally.findUnique({
    where: { id: rallyId },
    select: {
      boundaries: {
        select: { kind: true, captureTimeUs: true, captureFrameIndex: true },
      },
      keyPoints: {
        where: { deletedAt: null },
        orderBy: [
          { captureTimeUs: 'asc' },
          { captureFrameIndex: 'asc' },
          { sequenceIndex: 'asc' },
          { id: 'asc' },
        ],
        select: {
          id: true,
          sequenceIndex: true,
          captureTimeUs: true,
          captureFrameIndex: true,
          markerKind: true,
          ballEvent: {
            select: {
              kind: true,
              result: true,
              semanticSource: true,
              kindLocked: true,
              resultLocked: true,
            },
          },
        },
      },
    },
  })
  if (!rally) throw new TypeError('Rally no longer exists during BallEvent normalization')

  const normalized = normalizeBallEventKeyPoints({
    boundaries: rally.boundaries.map(boundary => ({
      kind: boundary.kind.toLowerCase() as 'start' | 'end',
      capture_time_us: boundary.captureTimeUs.toString(),
      capture_frame_index: boundary.captureFrameIndex.toString(),
    })),
    points: rally.keyPoints.map(point => ({
      key_point_id: point.id,
      sequence_index: point.sequenceIndex,
      capture_time_us: point.captureTimeUs.toString(),
      capture_frame_index: point.captureFrameIndex.toString(),
      event: wireEvent(point.ballEvent),
    })),
  })

  const pointById = new Map(rally.keyPoints.map(point => [point.id, point]))
  const aggregate = await tx.keyPoint.aggregate({
    _min: { sequenceIndex: true },
    where: { rallyId },
  })
  const temporaryBase = Math.min(
    -1,
    (aggregate._min.sequenceIndex ?? 0) - rally.keyPoints.length - 1,
  )
  for (const [index, point] of rally.keyPoints.entries()) {
    await tx.keyPoint.update({
      where: { id: point.id },
      data: { sequenceIndex: temporaryBase - index },
    })
  }

  const deletedAt = new Date()
  for (const keyPointId of normalized.tombstoned_key_point_ids) {
    await tx.keyPoint.update({
      where: { id: keyPointId },
      data: {
        deletedAt,
        updatedByUserId,
      },
    })
  }

  for (const point of normalized.points) {
    const previous = pointById.get(point.key_point_id)
    if (!previous) throw new TypeError('Normalized BallEvent references an unknown keypoint')
    const eventChanged =
      previous.ballEvent?.kind !== point.event.kind ||
      previous.ballEvent?.result !== point.event.result
    await tx.keyPoint.update({
      where: { id: point.key_point_id },
      data: { sequenceIndex: point.sequence_index, updatedByUserId },
    })
    await tx.ballEventDraft.upsert({
      where: { keyPointId: point.key_point_id },
      create: {
        keyPointId: point.key_point_id,
        kind: point.event.kind,
        result: point.event.result,
        semanticSource: 'SYSTEM_DEFAULT',
        kindLocked: false,
        resultLocked: false,
      },
      update: eventChanged
        ? {
            kind: point.event.kind,
            result: point.event.result,
            semanticSource: 'SYSTEM_DEFAULT',
            kindLocked: false,
            resultLocked: false,
          }
        : {
            kind: point.event.kind,
            result: point.event.result,
          },
    })
  }

  const duplicateCounts = new Map<string, number>()
  for (const point of normalized.points) {
    const current = pointById.get(point.key_point_id)
    if (current?.markerKind !== 'CONTACT') continue
    const frame = point.capture_frame_index
    duplicateCounts.set(frame, (duplicateCounts.get(frame) ?? 0) + 1)
  }
  for (const point of normalized.points) {
    const current = pointById.get(point.key_point_id)
    await tx.keyPoint.update({
      where: { id: point.key_point_id },
      data: {
        possibleDuplicate:
          current?.markerKind === 'CONTACT' &&
          (duplicateCounts.get(point.capture_frame_index) ?? 0) > 1,
      },
    })
  }

  return normalized.repairs
}
