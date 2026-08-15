import type { PrismaClient } from '@volleyball-monitoring/db'
import { describe, expect, it } from 'vitest'
import { createPlaybackPackagerWorker } from '../src/roles/playback-packager.js'

async function eventually(assertion: () => void, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      assertion()
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 2))
    }
  }
  assertion()
}

describe('playback packager lifecycle', () => {
  it('deletes only bounded batches of expired ephemeral windows', async () => {
    const rows = [
      { id: 'expired-a', expiresAt: new Date('2026-08-08T00:00:00.000Z') },
      { id: 'expired-b', expiresAt: new Date('2026-08-08T00:00:01.000Z') },
      { id: 'future', expiresAt: new Date('2026-08-08T01:00:00.000Z') },
    ]
    let disconnected = false
    const database = {
      playbackWindow: {
        findMany: async ({ where, take }: { where: { expiresAt: { lte: Date } }; take: number }) =>
          rows
            .filter(row => row.expiresAt <= where.expiresAt.lte)
            .slice(0, take)
            .map(({ id }) => ({ id })),
        deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
          const ids = new Set(where.id.in)
          const before = rows.length
          for (let index = rows.length - 1; index >= 0; index -= 1)
            if (ids.has(rows[index]!.id)) rows.splice(index, 1)
          return { count: before - rows.length }
        },
      },
      $disconnect: async () => {
        disconnected = true
      },
    } as unknown as PrismaClient
    const worker = createPlaybackPackagerWorker(database, {
      batchSize: 1,
      idleMs: 1,
      now: () => new Date('2026-08-08T00:30:00.000Z'),
    })

    await worker.start()
    await eventually(() => expect(rows.map(row => row.id)).toEqual(['future']))
    await worker.stop()

    expect(disconnected).toBe(true)
  })

  it('rejects unsafe cleanup batch sizes before starting', () => {
    const database = {} as PrismaClient
    expect(() => createPlaybackPackagerWorker(database, { batchSize: 0 })).toThrow(
      'between 1 and 1000',
    )
    expect(() => createPlaybackPackagerWorker(database, { batchSize: 1_001 })).toThrow(
      'between 1 and 1000',
    )
  })
})
