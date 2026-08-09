import { resolve } from 'node:path'
import type { PrismaClient } from '@volleyball-monitoring/db'
import { UserRole } from '@volleyball-monitoring/db/client'
import { describe, expect, it, vi } from 'vitest'

process.env.DATABASE_URL ??= 'postgresql://volleyball:volleyball@127.0.0.1:5433/volleyball?schema=public'
const { deleteMatchWithMedia } = await import('../src/services/match-administration.js')

const matchId = '71000000-0000-4000-8000-000000000001'
const captureId = '71000000-0000-4000-8000-000000000002'
const operator = { id: '71000000-0000-4000-8000-000000000003', role: UserRole.OPERATOR }

function deletionTransaction() {
  const remove = () => vi.fn().mockResolvedValue({ count: 1 })
  const tx = {
    captureEpoch: { deleteMany: remove() },
    captureSession: { deleteMany: remove() },
    dvrProgram: { deleteMany: remove() },
    match: { delete: vi.fn().mockResolvedValue({ id: matchId }) },
    mediaAsset: { deleteMany: remove() },
    outboxEvent: { deleteMany: remove() },
    playbackWindow: { deleteMany: remove() },
    rally: { findMany: vi.fn().mockResolvedValue([]) },
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
      .mockResolvedValueOnce([{ id: sharedAsset.id }])
    const database = {
      $transaction: vi.fn(async (work: (client: typeof tx) => Promise<void>) => work(tx)),
      match: { findFirst: vi.fn().mockResolvedValue({
        captureSessions: [{ id: captureId, ingestPath: `capture/${captureId}`, sourceKind: 'youtube_vod', status: 'LIVE' }],
        id: matchId,
        matchTeams: [],
        rosterEntries: [],
      }) },
      mediaAsset: { findMany: mediaAssetFindMany },
    } as unknown as PrismaClient
    const stop = vi.fn().mockResolvedValue(undefined)
    const objectRemover = vi.fn().mockResolvedValue(undefined)
    const removePath = vi.fn().mockResolvedValue(undefined)

    const result = await deleteMatchWithMedia(operator, matchId, {
      database,
      importRoot: '/imports',
      mediaSourceGateway: { start: vi.fn(), stop },
      objectRemover,
      recordingRoot: '/recordings',
      removePath,
    })

    expect(stop).toHaveBeenCalledWith(captureId)
    expect(tx.match.delete).toHaveBeenCalledWith({ where: { id: matchId } })
    expect(objectRemover).toHaveBeenCalledTimes(1)
    expect(objectRemover).toHaveBeenCalledWith(expect.objectContaining({ id: uniqueAsset.id }))
    expect(objectRemover).not.toHaveBeenCalledWith(expect.objectContaining({ id: sharedAsset.id }))
    expect(removePath).toHaveBeenCalledWith(resolve('/recordings', `capture/${captureId}`))
    expect(removePath).toHaveBeenCalledWith(resolve('/imports', captureId))
    expect(result).toEqual({ cleanupWarnings: [], matchId, removedAssetCount: 1, removedBytes: '120' })
  })

  it('rejects non-operator deletion before reading match data', async () => {
    const findFirst = vi.fn()
    const database = { match: { findFirst } } as unknown as PrismaClient
    await expect(deleteMatchWithMedia(
      { id: '71000000-0000-4000-8000-000000000004', role: UserRole.COACH },
      matchId,
      { database, importRoot: '/imports', recordingRoot: '/recordings' },
    )).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } })
    expect(findFirst).not.toHaveBeenCalled()
  })
})
