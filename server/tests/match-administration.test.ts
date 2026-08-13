import { resolve } from 'node:path'
import type { PrismaClient } from '@volleyball-monitoring/db'
import { UserRole } from '@volleyball-monitoring/db/client'
import { describe, expect, it, vi } from 'vitest'

process.env.DATABASE_URL ??= 'postgresql://volleyball:volleyball@127.0.0.1:5433/volleyball?schema=public'
const { finalizeMatchDeletion, requestMatchDeletion } = await import('../src/services/match-administration.js')

const matchId = '71000000-0000-4000-8000-000000000001'
const captureId = '71000000-0000-4000-8000-000000000002'
const operator = { id: '71000000-0000-4000-8000-000000000003', role: UserRole.OPERATOR }

function deletionTransaction() {
  const remove = () => vi.fn().mockResolvedValue({ count: 1 })
  const tx = {
    aiJob: { deleteMany: remove(), findMany: vi.fn().mockResolvedValue([]) },
    analysisRun: { deleteMany: remove(), findMany: vi.fn().mockResolvedValue([]) },
    annotationCommandReceipt: { deleteMany: remove() },
    annotationOperation: { deleteMany: remove() },
    captureEpoch: { deleteMany: remove() },
    captureSession: { deleteMany: remove() },
    clipJob: { deleteMany: remove(), findMany: vi.fn().mockResolvedValue([]) },
    dvrProgram: { deleteMany: remove() },
    match: { delete: vi.fn().mockResolvedValue({ id: matchId }) },
    mediaAsset: { deleteMany: remove() },
    outboxEvent: { deleteMany: remove() },
    playbackWindow: { deleteMany: remove() },
    pointAward: { deleteMany: remove() },
    rally: { deleteMany: remove(), findMany: vi.fn().mockResolvedValue([]) },
    rallySubmission: { deleteMany: remove(), findMany: vi.fn().mockResolvedValue([]), updateMany: remove() },
    rallySubmissionBoundary: { deleteMany: remove() },
    rallySubmissionKeyPoint: { deleteMany: remove(), findMany: vi.fn().mockResolvedValue([]) },
    scoreLedgerEntry: { deleteMany: remove() },
  }
  return tx
}

describe('match administration', () => {
  it('deletes match-owned media while retaining shared object storage', async () => {
    const uniqueAsset = { bucket: 'media', byteLength: 120n, id: 'asset-unique', objectKey: 'unique.m4s' }
    const sharedAsset = { bucket: 'media', byteLength: 80n, id: 'asset-shared', objectKey: 'shared.m4s' }
    const tx = deletionTransaction()
    const mediaAssetFindMany = vi.fn()
      .mockResolvedValueOnce([uniqueAsset, sharedAsset])
      .mockResolvedValueOnce([uniqueAsset])
    const transaction = vi.fn(async (work: (client: typeof tx) => Promise<void>) => work(tx))
    const database = {
      $transaction: transaction,
      match: { findFirst: vi.fn().mockResolvedValue({
        captureSessions: [{ id: captureId, ingestPath: `capture/${captureId}`, sourceKind: 'youtube_vod', status: 'LIVE' }],
        id: matchId,
        matchTeams: [],
        rosterEntries: [],
      }) },
      mediaAsset: { findMany: mediaAssetFindMany },
      mediaSourceWork: { count: vi.fn().mockResolvedValue(0) },
    } as unknown as PrismaClient
    const stop = vi.fn().mockResolvedValue(undefined)
    const objectRemover = vi.fn().mockResolvedValue(undefined)
    const removePath = vi.fn().mockResolvedValue(undefined)

    const result = await finalizeMatchDeletion(matchId, {
      database,
      importRoot: '/imports',
      stopMediaSource: stop,
      objectRemover,
      recordingRoot: '/recordings',
      removePath,
    })

    expect(stop).toHaveBeenCalledWith(database, captureId)
    expect(database.mediaSourceWork.count).toHaveBeenCalledWith({ where: {
      captureSessionId: { in: [captureId] },
      OR: [
        { status: { in: ['RUNNING', 'DRAINING'] } },
        { attempts: { gt: 0 }, status: 'STOP_REQUESTED' },
      ],
    } })
    expect(tx.match.delete).toHaveBeenCalledWith({ where: { id: matchId } })
    expect(objectRemover).toHaveBeenCalledTimes(1)
    expect(objectRemover).toHaveBeenCalledWith(expect.objectContaining({ id: uniqueAsset.id }))
    expect(objectRemover).not.toHaveBeenCalledWith(expect.objectContaining({ id: sharedAsset.id }))
    expect(removePath).toHaveBeenCalledWith(resolve('/recordings', `capture/${captureId}`))
    expect(removePath).toHaveBeenCalledWith(resolve('/imports', captureId))
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(objectRemover.mock.invocationCallOrder[0]!)
    expect(objectRemover.mock.invocationCallOrder[0]).toBeLessThan(transaction.mock.invocationCallOrder[0]!)
    expect(removePath.mock.invocationCallOrder[0]).toBeLessThan(transaction.mock.invocationCallOrder[0]!)
    expect(result).toEqual({ cleanupWarnings: [], matchId, removedAssetCount: 1, removedBytes: '120' })
  })

  it('keeps match data when required media cleanup fails', async () => {
    const asset = { bucket: 'media', byteLength: 120n, id: 'asset-unique', objectKey: 'unique.m4s' }
    const tx = deletionTransaction()
    const database = {
      $transaction: vi.fn(async (work: (client: typeof tx) => Promise<void>) => work(tx)),
      match: { findFirst: vi.fn().mockResolvedValue({
        captureSessions: [{ id: captureId, ingestPath: `capture/${captureId}`, sourceKind: 'youtube_live', status: 'LIVE' }],
        id: matchId,
        matchTeams: [],
        rosterEntries: [],
      }) },
      mediaAsset: { findMany: vi.fn().mockResolvedValueOnce([asset]).mockResolvedValueOnce([asset]) },
      mediaSourceWork: { count: vi.fn().mockResolvedValue(0) },
    } as unknown as PrismaClient
    const objectRemover = vi.fn().mockRejectedValue(new Error('storage unavailable'))

    await expect(finalizeMatchDeletion(matchId, {
      database,
      importRoot: '/imports',
      stopMediaSource: vi.fn().mockResolvedValue(undefined),
      objectRemover,
      recordingRoot: '/recordings',
      removePath: vi.fn().mockResolvedValue(undefined),
    })).rejects.toThrow('Media object cleanup failed; match was not deleted')

    expect(database.$transaction).not.toHaveBeenCalled()
    expect(tx.match.delete).not.toHaveBeenCalled()
  })

  it('removes immutable boundary copies before deleting v3 submissions', async () => {
    const rallyId = '71000000-0000-4000-8000-000000000010'
    const submissionId = '71000000-0000-4000-8000-000000000011'
    const tx = deletionTransaction()
    tx.rally.findMany.mockResolvedValue([{ id: rallyId }])
    tx.rallySubmission.findMany.mockResolvedValue([{ id: submissionId }])
    const database = {
      $transaction: vi.fn(async (work: (client: typeof tx) => Promise<void>) => work(tx)),
      match: { findFirst: vi.fn().mockResolvedValue({
        captureSessions: [], id: matchId, matchTeams: [], rosterEntries: [],
      }) },
      mediaAsset: { findMany: vi.fn().mockResolvedValue([]) },
      mediaSourceWork: { count: vi.fn().mockResolvedValue(0) },
    } as unknown as PrismaClient

    await finalizeMatchDeletion(matchId, {
      database,
      importRoot: '/imports',
      recordingRoot: '/recordings',
      removePath: vi.fn().mockResolvedValue(undefined),
    })

    expect(tx.rallySubmissionBoundary.deleteMany).toHaveBeenCalledWith({
      where: { submissionId: { in: [submissionId] } },
    })
    expect(tx.rallySubmissionBoundary.deleteMany.mock.invocationCallOrder[0])
      .toBeLessThan(tx.rallySubmission.deleteMany.mock.invocationCallOrder[0]!)
  })

  it('cleans large object sets with bounded concurrency before deleting database rows', async () => {
    const assets = Array.from({ length: 12 }, (_, index) => ({
      bucket: 'media',
      byteLength: 1n,
      id: `asset-${index}`,
      objectKey: `${index}.m4s`,
    }))
    const tx = deletionTransaction()
    tx.mediaAsset.deleteMany.mockResolvedValue({ count: assets.length })
    const transaction = vi.fn(async (work: (client: typeof tx) => Promise<void>) => work(tx))
    const database = {
      $transaction: transaction,
      match: { findFirst: vi.fn().mockResolvedValue({
        captureSessions: [],
        id: matchId,
        matchTeams: [],
        rosterEntries: [],
      }) },
      mediaAsset: { findMany: vi.fn().mockResolvedValueOnce(assets).mockResolvedValueOnce(assets) },
      mediaSourceWork: { count: vi.fn().mockResolvedValue(0) },
    } as unknown as PrismaClient
    let active = 0
    let maximumActive = 0
    const objectRemover = vi.fn(async () => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise(resolvePromise => setTimeout(resolvePromise, 1))
      active -= 1
    })

    await finalizeMatchDeletion(matchId, {
      database,
      importRoot: '/imports',
      objectRemover,
      recordingRoot: '/recordings',
      removePath: vi.fn().mockResolvedValue(undefined),
    })

    expect(objectRemover).toHaveBeenCalledTimes(assets.length)
    expect(maximumActive).toBeGreaterThan(1)
    expect(maximumActive).toBeLessThanOrEqual(8)
    expect(objectRemover.mock.invocationCallOrder.at(-1)).toBeLessThan(transaction.mock.invocationCallOrder[0]!)
  })

  it('marks deletion before requesting source shutdown and returns without media cleanup', async () => {
    const update = vi.fn().mockResolvedValue({ id: matchId })
    const database = {
      match: {
        findFirst: vi.fn().mockResolvedValue({
          captureSessions: [{ id: captureId, sourceKind: 'youtube_live', status: 'LIVE' }],
          id: matchId,
        }),
        update,
      },
    } as unknown as PrismaClient
    const stopMediaSource = vi.fn().mockResolvedValue(undefined)

    const result = await requestMatchDeletion(operator, matchId, { database, stopMediaSource })

    expect(update).toHaveBeenCalledWith({
      data: { deletionRequestedAt: expect.any(Date) },
      where: { id: matchId },
    })
    expect(stopMediaSource).toHaveBeenCalledWith(database, captureId)
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(stopMediaSource.mock.invocationCallOrder[0]!)
    expect(result).toEqual({ cleanupWarnings: [], matchId, removedAssetCount: 0, removedBytes: '0' })
  })

  it('rejects non-operator deletion before reading match data', async () => {
    const findFirst = vi.fn()
    const database = { match: { findFirst } } as unknown as PrismaClient
    await expect(requestMatchDeletion(
      { id: '71000000-0000-4000-8000-000000000004', role: UserRole.COACH },
      matchId,
      { database },
    )).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } })
    expect(findFirst).not.toHaveBeenCalled()
  })
})
