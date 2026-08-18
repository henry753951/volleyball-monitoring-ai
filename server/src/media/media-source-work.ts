import type { PrismaClient } from '@volleyball-monitoring/db'

export type MediaSourceWorkRequest = {
  captureSessionId: string
  sourceKind: 'youtube' | 'local_mp4' | 'rtmp'
  sourceUrl?: string
  importKey?: string
}

export async function scheduleMediaSourceWork(
  database: PrismaClient,
  request: MediaSourceWorkRequest,
): Promise<void> {
  await database.mediaSourceWork.create({
    data: {
      captureSessionId: request.captureSessionId,
      importKey: request.importKey ?? null,
      sourceKind: request.sourceKind,
      sourceUrl: request.sourceUrl ?? null,
    },
  })
}

export async function requestMediaSourceStop(
  database: PrismaClient,
  captureSessionId: string,
): Promise<{ count: number }> {
  return database.mediaSourceWork.updateMany({
    data: {
      availableAt: new Date(),
      status: 'STOP_REQUESTED',
    },
    where: {
      captureSessionId,
      status: { in: ['REQUESTED', 'RUNNING', 'DRAINING'] },
    },
  })
}
