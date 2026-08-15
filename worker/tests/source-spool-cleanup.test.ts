import type { PrismaClient } from '@volleyball-monitoring/db'
import { describe, expect, it, vi } from 'vitest'
import {
  cleanupCompletedMediaSpools,
  completedMediaSpoolPath,
} from '../src/media/source-runtime.js'

describe('completed media spool cleanup', () => {
  it('removes only direct ingest children selected by the durable database gate', async () => {
    const remove = vi.fn(async () => undefined)
    const load = vi.fn(async () => [{ workId: 'work-1', ingestPath: 'youtube-safe' }])

    await expect(
      cleanupCompletedMediaSpools({} as PrismaClient, '/recordings', { load, remove }),
    ).resolves.toBe(1)

    expect(remove).toHaveBeenCalledWith(completedMediaSpoolPath('/recordings', 'youtube-safe'))
  })

  it.each(['', '.', '..', '../outside', 'nested/capture', '/outside'])(
    'rejects unsafe ingest path %j',
    ingestPath => {
      expect(() => completedMediaSpoolPath('/recordings', ingestPath)).toThrow(
        'outside the recording root',
      )
    },
  )
})
