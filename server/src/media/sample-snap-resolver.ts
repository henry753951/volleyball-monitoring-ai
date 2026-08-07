import { resolveCanonicalTimeAcrossSegments, type IndexedSegment } from '@volleyball-monitoring/media'
import { createSampleIndexRepository } from './sample-index-repository.js'
import type { MediaObjectReader } from './playback-domain.js'
import type { PrismaClient } from '@volleyball-monitoring/db'

export function createSampleSnapResolver(load: (ids: readonly string[]) => Promise<readonly IndexedSegment[]>) {
  return async (input: { targetUs: bigint; segments: readonly { id: string; captureStartUs: bigint; captureEndUs: bigint }[] }) => {
    if (!input.segments.length) throw new Error('sample resolver requires segments')
    const indexes = await load(input.segments.map((segment) => segment.id))
    const first = input.segments[0]!
    const last = input.segments.at(-1)!
    const resolved = resolveCanonicalTimeAcrossSegments(indexes, input.targetUs, first.captureStartUs, last.captureEndUs)
    const captureUs = BigInt(resolved.sample.captureTimeUs)
    if (captureUs < first.captureStartUs || captureUs >= last.captureEndUs) throw new Error('sample snap is outside selected range')
    return { captureUs, playerUs: captureUs - first.captureStartUs }
  }
}

export function createPersistedSampleSnapResolver(database: PrismaClient, objectReader: MediaObjectReader) {
  const repository = createSampleIndexRepository(database, objectReader)
  return createSampleSnapResolver((ids) => repository.loadOrderedSegments(ids))
}
