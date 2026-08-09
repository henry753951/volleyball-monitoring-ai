import { rm } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { PrismaClient } from '@volleyball-monitoring/db'
import { UserRole } from '@volleyball-monitoring/db/client'
import type { AuthenticatedUser } from '../graphql/context.js'
import { domainError } from '../graphql/errors.js'
import type { MediaObjectLocation, MediaObjectRemover } from '../media/media-object-remover.js'
import type { MediaSourceGateway } from '../media/media-source-gateway.js'
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
  mediaSourceGateway?: MediaSourceGateway
  objectRemover?: MediaObjectRemover
  recordingRoot: string
  removePath?: (path: string) => Promise<void>
}

interface CleanupAsset extends MediaObjectLocation { byteLength: bigint | null; id: string }

function safeChild(root: string, child: string): string | null {
  const base = resolve(root)
  const target = isAbsolute(child) ? resolve(child) : resolve(base, child)
  const relation = relative(base, target)
  return relation && !relation.startsWith('..') && !isAbsolute(relation) ? target : null
}

export async function deleteMatchWithMedia(
  actor: AuthenticatedUser,
  rawMatchId: string,
  dependencies: MatchCleanupDependencies,
): Promise<MatchDeleteReceipt> {
  if (actor.role !== UserRole.ADMIN && actor.role !== UserRole.OPERATOR) domainError('Insufficient role', 'FORBIDDEN')
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
      ...(actor.role === UserRole.ADMIN ? {} : { members: { some: { userId: actor.id, role: { in: [UserRole.ADMIN, UserRole.OPERATOR] } } } }),
    },
  })
  if (!match) domainError('Match was not found', 'NOT_FOUND')

  const assets = await database.mediaAsset.findMany({
    select: { bucket: true, byteLength: true, id: true, objectKey: true },
    where: { OR: [
      { dvrInitSegments: { some: { program: { captureSession: { matchId } } } } },
      { dvrMediaSegments: { some: { program: { captureSession: { matchId } } } } },
      { dvrSampleIndexSegments: { some: { program: { captureSession: { matchId } } } } },
      { clipOutputs: { some: { submission: { rally: { matchId } } } } },
      { clipTimingManifests: { some: { submission: { rally: { matchId } } } } },
      { analysisRawJson: { some: { submission: { rally: { matchId } } } } },
      { analysisRawOverlay: { some: { submission: { rally: { matchId } } } } },
      { analysisArtifacts: { some: { analysisRun: { submission: { rally: { matchId } } } } } },
      { overlayChunks: { some: { manifest: { analysisRun: { submission: { rally: { matchId } } } } } } },
    ] },
  }) as CleanupAsset[]

  if (dependencies.mediaSourceGateway) {
    await Promise.all(match.captureSessions
      .filter(capture => !['FAILED', 'FINISHED'].includes(capture.status))
      .filter(capture => ['local_mp4', 'youtube', 'youtube_live', 'youtube_vod'].includes(capture.sourceKind))
      .map(capture => dependencies.mediaSourceGateway!.stop(capture.id).catch(() => undefined)))
  }

  const captureIds = match.captureSessions.map(capture => capture.id)
  const teamIds = match.matchTeams.map(item => item.teamId)
  const playerIds = match.rosterEntries.flatMap(item => item.playerId ? [item.playerId] : [])
  await database.$transaction(async (tx) => {
    const rallyIds = (await tx.rally.findMany({ select: { id: true }, where: { matchId } })).map(item => item.id)
    const submissionIds = rallyIds.length
      ? (await tx.rallySubmission.findMany({ select: { id: true }, where: { rallyId: { in: rallyIds } } })).map(item => item.id)
      : []
    const submissionKeyPointIds = submissionIds.length
      ? (await tx.rallySubmissionKeyPoint.findMany({ select: { id: true }, where: { submissionId: { in: submissionIds } } })).map(item => item.id)
      : []
    const clipJobIds = submissionIds.length
      ? (await tx.clipJob.findMany({ select: { id: true }, where: { submissionId: { in: submissionIds } } })).map(item => item.id)
      : []
    const aiJobIds = submissionIds.length
      ? (await tx.aiJob.findMany({ select: { id: true }, where: { submissionId: { in: submissionIds } } })).map(item => item.id)
      : []
    const analysisRunIds = submissionIds.length
      ? (await tx.analysisRun.findMany({ select: { id: true }, where: { submissionId: { in: submissionIds } } })).map(item => item.id)
      : []

    const aggregateIds = [matchId, ...captureIds, ...rallyIds, ...submissionIds, ...clipJobIds, ...aiJobIds, ...analysisRunIds]
    await tx.outboxEvent.deleteMany({ where: { aggregateId: { in: aggregateIds } } })

    if (analysisRunIds.length) await tx.analysisRun.deleteMany({ where: { id: { in: analysisRunIds } } })
    if (aiJobIds.length) await tx.aiJob.deleteMany({ where: { id: { in: aiJobIds } } })
    if (clipJobIds.length) await tx.clipJob.deleteMany({ where: { id: { in: clipJobIds } } })
    if (submissionIds.length) {
      await tx.pointAward.deleteMany({ where: { submissionId: { in: submissionIds } } })
      await tx.scoreLedgerEntry.deleteMany({ where: { OR: [{ submissionId: { in: submissionIds } }, { supersededSubmissionId: { in: submissionIds } }] } })
      await tx.rallySubmission.updateMany({ data: { serviceKeyPointId: null, supersedesSubmissionId: null, terminalKeyPointId: null }, where: { id: { in: submissionIds } } })
    }
    if (submissionKeyPointIds.length) await tx.rallySubmissionKeyPoint.deleteMany({ where: { id: { in: submissionKeyPointIds } } })
    if (submissionIds.length) await tx.rallySubmission.deleteMany({ where: { id: { in: submissionIds } } })
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
    if (assets.length) await tx.mediaAsset.deleteMany({ where: {
      id: { in: assets.map(asset => asset.id) }, analysisArtifacts: { none: {} }, analysisRawJson: { none: {} }, analysisRawOverlay: { none: {} },
      clipOutputs: { none: {} }, clipTimingManifests: { none: {} }, dvrInitSegments: { none: {} }, dvrMediaSegments: { none: {} },
      dvrSampleIndexSegments: { none: {} }, overlayChunks: { none: {} },
    } })
    if (playerIds.length) await tx.player.deleteMany({ where: { id: { in: playerIds }, rosterEntries: { none: {} } } })
    if (teamIds.length) await tx.team.deleteMany({ where: { id: { in: teamIds }, matchTeams: { none: {} } } })
  })

  const retainedAssetIds = assets.length
    ? new Set((await database.mediaAsset.findMany({
        select: { id: true },
        where: { id: { in: assets.map(asset => asset.id) } },
      })).map(asset => asset.id))
    : new Set<string>()
  const removedAssets = assets.filter(asset => !retainedAssetIds.has(asset.id))
  const cleanupWarnings: string[] = []
  if (dependencies.objectRemover) {
    for (const asset of removedAssets) {
      try { await dependencies.objectRemover(asset) }
      catch { cleanupWarnings.push(`物件儲存清理失敗：${asset.bucket}/${asset.objectKey}`) }
    }
  }
  else if (removedAssets.length) cleanupWarnings.push('物件儲存清理未設定')

  const removePath = dependencies.removePath ?? (path => rm(path, { force: true, recursive: true }))
  const paths = new Set<string>()
  for (const capture of match.captureSessions) {
    const recordingPath = safeChild(dependencies.recordingRoot, capture.ingestPath)
    if (recordingPath) paths.add(recordingPath)
    const importPath = safeChild(dependencies.importRoot, capture.id)
    if (importPath) paths.add(importPath)
  }
  for (const path of paths) {
    try { await removePath(path) }
    catch { cleanupWarnings.push(`本機媒體清理失敗：${path}`) }
  }

  return {
    cleanupWarnings,
    matchId,
    removedAssetCount: removedAssets.length,
    removedBytes: removedAssets.reduce((total, asset) => total + (asset.byteLength ?? 0n), 0n).toString(),
  }
}
