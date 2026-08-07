import type { PrismaClient } from '@volleyball-monitoring/db'
import {
  resolveCanonicalTimeAcrossSegments,
  type IndexedSegment,
} from '@volleyball-monitoring/media'
import type { MediaObjectReader } from './playback-domain.js'
import { createSampleIndexRepository } from './sample-index-repository.js'

export type SampleSnapSegment = {
  id: string
  captureStartUs: bigint
  captureEndUs: bigint
}

export type SampleSnapInput = {
  targetUs: bigint
  segments: readonly SampleSnapSegment[]
}

export type SampleSnapLoader = (
  segmentIds: readonly string[],
) => Promise<readonly IndexedSegment[]>

export function createSampleSnapResolver(loader: SampleSnapLoader) {
  return async ({ targetUs, segments }: SampleSnapInput) => {
    if (segments.length === 0) {
      throw new Error('sample resolver requires segments')
    }
    const ids = segments.map((segment) => segment.id)
    const indexes = await loader(ids)
    if (indexes.length !== ids.length) {
      throw new Error('sample index segment count mismatch')
    }
    for (const [position, index] of indexes.entries()) {
      if (index.segmentId !== ids[position]) {
        throw new Error('sample index segment order mismatch')
      }
    }
    const first = segments[0]!
    const last = segments.at(-1)!
    if (targetUs < first.captureStartUs || targetUs > last.captureEndUs) {
      throw new Error('sample target is outside selected range')
    }
    const resolverTargetUs = targetUs === last.captureEndUs
      ? targetUs - 1n
      : targetUs
    const resolved = resolveCanonicalTimeAcrossSegments(
      indexes,
      resolverTargetUs,
      first.captureStartUs,
      last.captureEndUs,
    )
    const captureUs = BigInt(resolved.sample.captureTimeUs)
    if (captureUs < first.captureStartUs || captureUs >= last.captureEndUs) {
      throw new Error('sample snap is outside selected range')
    }
    return { captureUs, playerUs: captureUs - first.captureStartUs }
  }
}

export function createPersistedSampleSnapResolver(
  database: PrismaClient,
  objectReader: MediaObjectReader,
) {
  const repository = createSampleIndexRepository(database, objectReader)
  return createSampleSnapResolver((ids) => repository.loadOrderedSegments(ids))
}
