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
  discontinuity: number
}

export type SampleSnapInput = {
  targetUs: bigint
  segments: readonly SampleSnapSegment[]
}

export type SampleSnapLoader = (segmentIds: readonly string[]) => Promise<readonly IndexedSegment[]>

export function createSampleSnapResolver(loader: SampleSnapLoader) {
  return async ({ targetUs, segments }: SampleSnapInput) => {
    if (segments.length === 0) {
      throw new Error('sample resolver requires segments')
    }
    const first = segments[0]!
    const last = segments.at(-1)!
    if (targetUs < first.captureStartUs || targetUs > last.captureEndUs) {
      throw new Error('sample target is outside selected range')
    }
    const resolverTargetUs = targetUs === last.captureEndUs ? targetUs - 1n : targetUs
    const targetIndex = segments.findIndex(
      segment =>
        segment.captureStartUs <= resolverTargetUs && resolverTargetUs < segment.captureEndUs,
    )
    if (targetIndex < 0) {
      throw new Error('sample target has no selected segment')
    }

    // A playback window can contain hundreds of short recorder fragments. A
    // cursor snap only needs the target fragment and its immediate neighbours
    // to preserve nearest-frame behavior at a boundary. Loading the complete
    // window would exceed the repository request bound and make every seek
    // proportional to the requested DVR duration.
    const target = segments[targetIndex]!
    let neighborhoodStart = targetIndex
    let neighborhoodEnd = targetIndex
    const previous = segments[targetIndex - 1]
    if (
      previous &&
      previous.discontinuity === target.discontinuity &&
      previous.captureEndUs === target.captureStartUs
    )
      neighborhoodStart -= 1
    const next = segments[targetIndex + 1]
    if (
      next &&
      next.discontinuity === target.discontinuity &&
      next.captureStartUs === target.captureEndUs
    )
      neighborhoodEnd += 1
    const neighborhood = segments.slice(neighborhoodStart, neighborhoodEnd + 1)
    const ids = neighborhood.map(segment => segment.id)
    const indexes = await loader(ids)
    if (indexes.length !== ids.length) {
      throw new Error('sample index segment count mismatch')
    }
    for (const [position, index] of indexes.entries()) {
      if (index.segmentId !== ids[position]) {
        throw new Error('sample index segment order mismatch')
      }
    }
    const resolverStart = neighborhood[0]!
    const resolverEnd = neighborhood.at(-1)!
    const resolved = resolveCanonicalTimeAcrossSegments(
      indexes,
      resolverTargetUs,
      resolverStart.captureStartUs,
      resolverEnd.captureEndUs,
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
  return createSampleSnapResolver(ids => repository.loadOrderedSegments(ids))
}
