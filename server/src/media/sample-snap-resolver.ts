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
    if (segments.length === 0) throw new Error('sample resolver requires segments')
    const ids = segments.map((segment) => segment.id)
    const indexes = await loader(ids)
    if (indexes.length !== ids.length) throw new Error('sample index segment count mismatch')
    indexes.forEach((index, position) => {
      if (index.segmentId !== ids[position]) throw new Error('sample index segment order mismatch')
    })
    const first = segments[0]!
    const last = segments.at(-1)!
    const resolved = resolveCanonicalTimeAcrossSegments(
      indexes,
      targetUs,
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
