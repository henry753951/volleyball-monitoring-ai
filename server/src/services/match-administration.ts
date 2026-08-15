import { rm } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { PrismaClient } from '@volleyball-monitoring/db'
import { UserRole } from '@volleyball-monitoring/db/client'
import type { AuthenticatedUser } from '../graphql/context.js'
import { domainError } from '../graphql/errors.js'
import type { MediaObjectLocation, MediaObjectRemover } from '../media/media-object-remover.js'
import { requestMediaSourceStop } from '../media/media-source-work.js'
import { requireUuid } from './core-domain.js'

export interface MatchDeleteReceipt {
  matchId: string
  removedAssetCount: number
  removedBytes: string
  cleanupWarnings: string[]
}

export interface MatchCleanupDependencies {
  database: PrismaClient
  importRoot: string
  stopMediaSource?: typeof requestMediaSourceStop
  objectRemover?: MediaObjectRemover
  recordingRoot: string
  removePath?: (path: string) => Promise<void>
}

export interface MatchDeletionRequestDependencies {
  database: PrismaClient
  stopMediaSource?: typeof requestMediaSourceStop
}

interface CleanupAsset extends MediaObjectLocation {
  byteLength: bigint | null
  id: string
}
const OBJECT_CLEANUP_CONCURRENCY = 8

function safeChild(root: string, child: string): string | null {
  const base = resolve(root)
  const target = isAbsolute(child) ? resolve(child) : resolve(base, child)
  const relation = relative(base, target)
  return relation && !relation.startsWith('..') && !isAbsolute(relation) ? target : null
}

async function waitForMediaSourcesStopped(
  database: PrismaClient,
  captureSessionIds: string[],
  timeoutMs = 15_000,
): Promise<void> {
  if (captureSessionIds.length === 0) return
  const deadline = Date.now() + timeoutMs
  while (true) {
    const active = await database.mediaSourceWork.count({
      where: {
        captureSessionId: { in: captureSessionIds },
        OR: [
          { status: { in: ['RUNNING', 'DRAINING'] } },
          { attempts: { gt: 0 }, status: 'STOP_REQUESTED' },
        ],
      },
    })
    if (active === 0) return
    if (Date.now() >= deadline)
      throw new Error('Media source shutdown did not settle before match deletion')
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
}

export async function requestMatchDeletion(
  actor: AuthenticatedUser,
  rawMatchId: string,
  dependencies: MatchDeletionRequestDependencies,
): Promise<MatchDeleteReceipt> {
  if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.OPERATOR) {
    domainError('Insufficient role', 'FORBIDDEN')
  }
  const matchId = requireUuid(rawMatchId, 'matchId')
  const database = dependencies.database
  const match = await database.match.findFirst({
    select: {
      captureSessions: { select: { id: true, sourceKind: true, status: true } },
      id: true,
    },
    where: {
      deletionRequestedAt: null,
      id: matchId,
      ...(actor.role === UserRole.ADMIN
        ? {}
        : {
            members: {
              some: { userId: actor.id, role: { in: [UserRole.ADMIN, UserRole.OPERATOR] } },
            },
          }),
    },
  })
  if (!match) domainError('Match was not found', 'NOT_FOUND')

  await database.match.update({
    data: { deletionRequestedAt: new Date() },
    where: { id: matchId },
  })

  const sourceCaptures = match.captureSessions
    .filter(capture => !['FAILED', 'FINISHED'].includes(capture.status))
    .filter(capture =>
      ['local_mp4', 'youtube', 'youtube_live', 'youtube_vod'].includes(capture.sourceKind),
    )
  const stopMediaSource = dependencies.stopMediaSource ?? requestMediaSourceStop
  await Promise.allSettled(sourceCaptures.map(capture => stopMediaSource(database, capture.id)))

  return {
    cleanupWarnings: [],
    matchId,
    removedAssetCount: 0,
    removedBytes: '0',
  }
}

export async function finalizeMatchDeletion(
  rawMatchId: string,
  dependencies: MatchCleanupDependencies,
): Promise<MatchDeleteReceipt> {
  const matchId = requireUuid(rawMatchId, 'matchId')
  const database = dependencies.database
  const match = await database.match.findFirst({
    select: {
      id: true,
      captureSessions: { select: { id: true, ingestPath: true, sourceKind: true, status: true } },
      matchTeams: { select: { teamId: true } },
      rosterEntries: { select: { playerId: true } },
    },
    where: {
      id: matchId,
      deletionRequestedAt: { not: null },
    },
  })
  if (!match) throw new Error('Match deletion is not pending')

  const assets = (await database.mediaAsset.findMany({
    select: { bucket: true, byteLength: true, id: true, objectKey: true },
    where: {
      OR: [
        { dvrInitSegments: { some: { program: { captureSession: { matchId } } } } },
        { dvrMediaSegments: { some: { program: { captureSession: { matchId } } } } },
        { dvrSampleIndexSegments: { some: { program: { captureSession: { matchId } } } } },
        { clipOutputs: { some: { submission: { rally: { matchId } } } } },
        { clipTimingManifests: { some: { submission: { rally: { matchId } } } } },
        { analysisDataRaw: { some: { submission: { rally: { matchId } } } } },
        { analysisArtifacts: { some: { analysisRun: { submission: { rally: { matchId } } } } } },
        {
          analysisFrameChunks: {
            some: { manifest: { analysisRun: { submission: { rally: { matchId } } } } },
          },
        },
      ],
    },
  })) as CleanupAsset[]

  const removableAssets = assets.length
    ? ((await database.mediaAsset.findMany({
        select: { bucket: true, byteLength: true, id: true, objectKey: true },
        where: {
          id: { in: assets.map(asset => asset.id) },
          analysisArtifacts: {
            none: { analysisRun: { submission: { rally: { matchId: { not: matchId } } } } },
          },
          analysisDataRaw: { none: { submission: { rally: { matchId: { not: matchId } } } } },
          clipOutputs: { none: { submission: { rally: { matchId: { not: matchId } } } } },
          clipTimingManifests: { none: { submission: { rally: { matchId: { not: matchId } } } } },
          dvrInitSegments: { none: { program: { captureSession: { matchId: { not: matchId } } } } },
          dvrMediaSegments: {
            none: { program: { captureSession: { matchId: { not: matchId } } } },
          },
          dvrSampleIndexSegments: {
            none: { program: { captureSession: { matchId: { not: matchId } } } },
          },
          analysisFrameChunks: {
            none: {
              manifest: { analysisRun: { submission: { rally: { matchId: { not: matchId } } } } },
            },
          },
        },
      })) as CleanupAsset[])
    : []

  const sourceCaptures = match.captureSessions
    .filter(capture => !['FAILED', 'FINISHED'].includes(capture.status))
    .filter(capture =>
      ['local_mp4', 'youtube', 'youtube_live', 'youtube_vod'].includes(capture.sourceKind),
    )
  const stopMediaSource = dependencies.stopMediaSource ?? requestMediaSourceStop
  await Promise.all(sourceCaptures.map(capture => stopMediaSource(database, capture.id)))
  await waitForMediaSourcesStopped(
    database,
    sourceCaptures.map(capture => capture.id),
  )

  if (removableAssets.length > 0 && !dependencies.objectRemover) {
    throw new Error('Media object cleanup is not configured; match was not deleted')
  }
  if (dependencies.objectRemover)
    await removeMediaObjects(removableAssets, dependencies.objectRemover)

  const removePath = dependencies.removePath ?? (path => rm(path, { force: true, recursive: true }))
  const paths = new Set<string>()
  for (const capture of match.captureSessions) {
    const recordingPath = safeChild(dependencies.recordingRoot, capture.ingestPath)
    if (recordingPath) paths.add(recordingPath)
    const importPath = safeChild(dependencies.importRoot, capture.id)
    if (importPath) paths.add(importPath)
  }
  for (const path of paths) {
    try {
      await removePath(path)
    } catch {
      throw new Error(`Local media cleanup failed; match was not deleted: ${path}`)
    }
  }

  const captureIds = match.captureSessions.map(capture => capture.id)
  const teamIds = match.matchTeams.map(item => item.teamId)
  const playerIds = match.rosterEntries.flatMap(item => (item.playerId ? [item.playerId] : []))
  await database.$transaction(async tx => {
    const rallyIds = (await tx.rally.findMany({ select: { id: true }, where: { matchId } })).map(
      item => item.id,
    )
    const submissionIds = rallyIds.length
      ? (
          await tx.rallySubmission.findMany({
            select: { id: true },
            where: { rallyId: { in: rallyIds } },
          })
        ).map(item => item.id)
      : []
    const submissionKeyPointIds = submissionIds.length
      ? (
          await tx.rallySubmissionKeyPoint.findMany({
            select: { id: true },
            where: { submissionId: { in: submissionIds } },
          })
        ).map(item => item.id)
      : []
    const clipJobIds = submissionIds.length
      ? (
          await tx.clipJob.findMany({
            select: { id: true },
            where: { submissionId: { in: submissionIds } },
          })
        ).map(item => item.id)
      : []
    const aiJobIds = submissionIds.length
      ? (
          await tx.aiJob.findMany({
            select: { id: true },
            where: { submissionId: { in: submissionIds } },
          })
        ).map(item => item.id)
      : []
    const analysisRunIds = submissionIds.length
      ? (
          await tx.analysisRun.findMany({
            select: { id: true },
            where: { submissionId: { in: submissionIds } },
          })
        ).map(item => item.id)
      : []

    const aggregateIds = [
      matchId,
      ...captureIds,
      ...rallyIds,
      ...submissionIds,
      ...clipJobIds,
      ...aiJobIds,
      ...analysisRunIds,
    ]
    await tx.outboxEvent.deleteMany({ where: { aggregateId: { in: aggregateIds } } })

    if (analysisRunIds.length)
      await tx.analysisRun.deleteMany({ where: { id: { in: analysisRunIds } } })
    if (aiJobIds.length) await tx.aiJob.deleteMany({ where: { id: { in: aiJobIds } } })
    if (clipJobIds.length) await tx.clipJob.deleteMany({ where: { id: { in: clipJobIds } } })
    if (submissionIds.length) {
      await tx.pointAward.deleteMany({ where: { submissionId: { in: submissionIds } } })
      await tx.scoreLedgerEntry.deleteMany({
        where: {
          OR: [
            { submissionId: { in: submissionIds } },
            { supersededSubmissionId: { in: submissionIds } },
          ],
        },
      })
      await tx.rallySubmission.updateMany({
        data: { serviceKeyPointId: null, supersedesSubmissionId: null, terminalKeyPointId: null },
        where: { id: { in: submissionIds } },
      })
      await tx.rallySubmissionBoundary.deleteMany({
        where: { submissionId: { in: submissionIds } },
      })
    }
    if (submissionKeyPointIds.length)
      await tx.rallySubmissionKeyPoint.deleteMany({ where: { id: { in: submissionKeyPointIds } } })
    if (submissionIds.length)
      await tx.rallySubmission.deleteMany({ where: { id: { in: submissionIds } } })
    if (rallyIds.length) {
      await tx.annotationOperation.deleteMany({ where: { rallyId: { in: rallyIds } } })
      await tx.annotationCommandReceipt.deleteMany({ where: { rallyId: { in: rallyIds } } })
      await tx.rally.deleteMany({ where: { id: { in: rallyIds } } })
    }
    if (captureIds.length) {
      await tx.playbackWindow.deleteMany({ where: { captureSessionId: { in: captureIds } } })
      await tx.dvrProgram.deleteMany({ where: { captureSessionId: { in: captureIds } } })
      await tx.captureEpoch.deleteMany({ where: { captureSessionId: { in: captureIds } } })
      await tx.captureSession.deleteMany({ where: { id: { in: captureIds } } })
    }
    await tx.match.delete({ where: { id: matchId } })
    if (removableAssets.length) {
      const removed = await tx.mediaAsset.deleteMany({
        where: {
          id: { in: removableAssets.map(asset => asset.id) },
          analysisArtifacts: { none: {} },
          analysisDataRaw: { none: {} },
          clipOutputs: { none: {} },
          clipTimingManifests: { none: {} },
          dvrInitSegments: { none: {} },
          dvrMediaSegments: { none: {} },
          dvrSampleIndexSegments: { none: {} },
          analysisFrameChunks: { none: {} },
        },
      })
      if (removed.count !== removableAssets.length) {
        throw new Error('Media asset references changed during match deletion')
      }
    }
    if (playerIds.length)
      await tx.player.deleteMany({ where: { id: { in: playerIds }, rosterEntries: { none: {} } } })
    if (teamIds.length)
      await tx.team.deleteMany({ where: { id: { in: teamIds }, matchTeams: { none: {} } } })
  })

  return {
    cleanupWarnings: [],
    matchId,
    removedAssetCount: removableAssets.length,
    removedBytes: removableAssets
      .reduce((total, asset) => total + (asset.byteLength ?? 0n), 0n)
      .toString(),
  }
}

async function removeMediaObjects(
  assets: CleanupAsset[],
  remover: MediaObjectRemover,
): Promise<void> {
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(OBJECT_CLEANUP_CONCURRENCY, assets.length) },
    async () => {
      while (cursor < assets.length) {
        const asset = assets[cursor++]!
        try {
          await remover(asset)
        } catch {
          throw new Error(
            `Media object cleanup failed; match was not deleted: ${asset.bucket}/${asset.objectKey}`,
          )
        }
      }
    },
  )
  const results = await Promise.allSettled(workers)
  const failure = results.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
}
