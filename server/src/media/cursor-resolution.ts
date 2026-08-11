import {
  parseCanonicalFrameAnchor,
  parseResolvedMediaAnchor,
  type CanonicalFrameAnchor,
  type FrameStepRequest,
  type PlaybackCursor,
  type ResolvedMediaAnchor,
} from '@volleyball-monitoring/contracts'
import type { UserRole } from '@volleyball-monitoring/db/client'
import {
  frameStepAcrossSegments,
  resolveCanonicalTimeAcrossSegments,
  ResolverError,
  type IndexedSegment,
} from '@volleyball-monitoring/media'
import { MediaHttpError } from './playback-domain.js'

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

export interface CursorMediaIdentity {
  id: string
  role: UserRole
}

export interface CursorWindowSegment {
  id: string
  captureEpochId: string
  captureStartUs: bigint
  captureEndUs: bigint
  discontinuity: number
  dvrProgramId: string
  firstFrameIndex: bigint | null
  frameCount: bigint
  isGap: boolean
  ready: boolean
  sequenceIndex: number
  sequenceNumber: bigint
}

export interface CursorPlaybackWindow {
  id: string
  captureSessionId: string
  dvrProgramId: string
  programCaptureSessionId: string
  mappingVersion: number
  captureStartUs: bigint
  captureEndUs: bigint
  presentationOriginCaptureUs: bigint
  expiresAt: Date
  segments: readonly CursorWindowSegment[]
}

export interface CursorWindowStore {
  loadVisibleWindow(
    id: string,
    identity: CursorMediaIdentity,
  ): Promise<CursorPlaybackWindow | null>
  loadAdjacentSegment(input: {
    direction: 'previous' | 'next'
    edge: CursorWindowSegment
    identity: CursorMediaIdentity
    window: CursorPlaybackWindow
  }): Promise<CursorWindowSegment | null>
}

export interface CursorSampleIndexLoader {
  loadOrderedSegments(
    segmentIds: readonly string[],
  ): Promise<readonly IndexedSegment[]>
}

export interface CursorResolutionDependencies {
  now: () => Date
  sampleIndexes: CursorSampleIndexLoader
  store: CursorWindowStore
}

function mediaUnavailable(message: string): never {
  throw new MediaHttpError(409, 'MEDIA_NOT_READY', message)
}

function parseUuid(value: string, resource: string): string {
  if (!UUID.test(value)) {
    throw new MediaHttpError(404, 'NOT_FOUND', `${resource} not found`)
  }
  return value.toLowerCase()
}

function assertWindowActive(window: CursorPlaybackWindow, now: Date): void {
  if (
    Number.isNaN(window.expiresAt.getTime())
    || Number.isNaN(now.getTime())
  ) {
    mediaUnavailable('Playback window state is invalid')
  }
  if (window.expiresAt <= now) {
    throw new MediaHttpError(410, 'WINDOW_EXPIRED', 'Playback window expired')
  }
}

function assertWindowMapping(
  window: CursorPlaybackWindow,
  requestedId: string,
): readonly CursorWindowSegment[] {
  if (
    window.id.toLowerCase() !== requestedId
    || !UUID.test(window.id)
    || !UUID.test(window.captureSessionId)
    || !UUID.test(window.dvrProgramId)
    || window.programCaptureSessionId !== window.captureSessionId
    || !Number.isSafeInteger(window.mappingVersion)
    || window.mappingVersion < 1
    || window.captureStartUs < 0n
    || window.captureEndUs <= window.captureStartUs
    || window.presentationOriginCaptureUs < window.captureStartUs
    || window.presentationOriginCaptureUs >= window.captureEndUs
    || window.segments.length === 0
  ) {
    mediaUnavailable('Playback window mapping is invalid')
  }

  const ids = new Set<string>()
  let previous: CursorWindowSegment | undefined
  for (const [index, segment] of window.segments.entries()) {
    if (
      !UUID.test(segment.id)
      || !UUID.test(segment.captureEpochId)
      || segment.dvrProgramId !== window.dvrProgramId
      || ids.has(segment.id.toLowerCase())
      || segment.sequenceIndex !== index
      || !Number.isSafeInteger(segment.sequenceIndex)
      || segment.sequenceIndex < 0
      || segment.discontinuity < 0
      || !Number.isSafeInteger(segment.discontinuity)
      || segment.captureStartUs < 0n
      || segment.captureEndUs <= segment.captureStartUs
      || segment.firstFrameIndex === null
      || segment.firstFrameIndex < 0n
      || segment.frameCount <= 0n
      || segment.isGap
      || !segment.ready
    ) {
      mediaUnavailable('Playback window segment mapping is invalid')
    }
    ids.add(segment.id.toLowerCase())

    if (previous && (
      segment.sequenceNumber <= previous.sequenceNumber
      || segment.captureStartUs !== previous.captureEndUs
      || segment.firstFrameIndex
        !== previous.firstFrameIndex! + previous.frameCount
    )) {
      // Epoch-local source PTS may reset between adjacent OME fragments. The
      // canonical capture clock and frame index are the cross-epoch authority.
      mediaUnavailable('Playback window segment order is invalid')
    }
    previous = segment
  }

  if (
    window.segments[0]!.captureStartUs !== window.captureStartUs
    || window.segments.at(-1)!.captureEndUs !== window.captureEndUs
  ) {
    mediaUnavailable('Playback window bounds are invalid')
  }
  return window.segments
}

function mappingsForTarget(
  mappings: readonly CursorWindowSegment[],
  targetUs: bigint,
): readonly CursorWindowSegment[] {
  const targetIndex = mappings.findIndex(mapping => (
    mapping.captureStartUs <= targetUs && targetUs < mapping.captureEndUs
  ))
  if (targetIndex < 0) return []
  const target = mappings[targetIndex]!
  let first = targetIndex
  let last = targetIndex
  const previous = mappings[targetIndex - 1]
  if (
    previous
    && previous.discontinuity === target.discontinuity
    && previous.captureEndUs === target.captureStartUs
  ) first -= 1
  const next = mappings[targetIndex + 1]
  if (
    next
    && next.discontinuity === target.discontinuity
    && next.captureStartUs === target.captureEndUs
  ) last += 1
  return mappings.slice(first, last + 1)
}

async function loadWindow(
  id: string,
  identity: CursorMediaIdentity,
  deps: CursorResolutionDependencies,
): Promise<CursorPlaybackWindow> {
  let window: CursorPlaybackWindow | null
  try {
    window = await deps.store.loadVisibleWindow(id, identity)
  } catch {
    throw new MediaHttpError(
      500,
      'MEDIA_NOT_READY',
      'Playback window could not be read',
    )
  }
  if (!window) {
    throw new MediaHttpError(404, 'NOT_FOUND', 'Playback window not found')
  }
  assertWindowActive(window, deps.now())
  assertWindowMapping(window, id)
  return window
}

function assertMappingVersion(
  actual: number,
  requested: number,
): void {
  if (actual !== requested) {
    throw new MediaHttpError(409, 'MAPPING_STALE', 'Playback mapping is stale')
  }
}

async function loadIndexes(
  loader: CursorSampleIndexLoader,
  mappings: readonly CursorWindowSegment[],
): Promise<readonly IndexedSegment[]> {
  let indexed: readonly IndexedSegment[]
  try {
    indexed = await loader.loadOrderedSegments(
      mappings.map((segment) => segment.id),
    )
  } catch {
    throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'Sample index is unavailable')
  }
  if (
    indexed.length !== mappings.length
    || indexed.some((segment, index) => {
      const mapping = mappings[index]!
      const firstSample = segment.index.samples[0]
      return firstSample === undefined
        || segment.segmentId.toLowerCase() !== mapping.id.toLowerCase()
        || segment.index.epochId.toLowerCase()
          !== mapping.captureEpochId.toLowerCase()
        || (segment.discontinuity ?? 0) !== mapping.discontinuity
        || segment.index.availableStartUs !== mapping.captureStartUs
        || segment.index.availableEndUs !== mapping.captureEndUs
        || firstSample.captureFrameIndex !== mapping.firstFrameIndex
        || BigInt(segment.index.samples.length) !== mapping.frameCount
    })
  ) {
    mediaUnavailable('Sample index mapping is invalid')
  }
  return indexed
}

function resolverFailure(error: unknown): never {
  if (!(error instanceof ResolverError)) throw error
  if (error.code === 'WINDOW_BOUNDARY') {
    throw new MediaHttpError(
      409,
      'WINDOW_BOUNDARY',
      'Adjacent sample is outside the playback window',
    )
  }
  if (error.code === 'SAMPLE_NOT_FOUND') {
    throw new MediaHttpError(422, 'SAMPLE_NOT_FOUND', 'Sample was not found')
  }
  if (error.code === 'CAPTURE_GAP') {
    throw new MediaHttpError(422, 'CAPTURE_GAP', 'Cursor is outside available media')
  }
  throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'Sample index mapping is invalid')
}

function wireTimeBase(segment: IndexedSegment): { num: number; den: number } {
  const { num, den } = segment.index.timeBase
  if (
    num < 1n
    || den < 1n
    || num > BigInt(Number.MAX_SAFE_INTEGER)
    || den > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    mediaUnavailable('Sample time base is invalid')
  }
  return { num: Number(num), den: Number(den) }
}

function indexedSegment(
  segments: readonly IndexedSegment[],
  id: string,
): IndexedSegment {
  const segment = segments.find((candidate) =>
    candidate.segmentId.toLowerCase() === id.toLowerCase())
  if (!segment) mediaUnavailable('Resolved sample mapping is invalid')
  return segment
}

function resolvedPlayerTime(
  captureTimeUs: string,
  window: CursorPlaybackWindow,
): string {
  const captureUs = BigInt(captureTimeUs)
  const playerUs = captureUs - window.presentationOriginCaptureUs
  if (
    playerUs < 0n
    || captureUs < window.captureStartUs
    || captureUs >= window.captureEndUs
  ) {
    mediaUnavailable('Resolved sample is outside the playback window')
  }
  return playerUs.toString()
}

function validateResolvedResponse(
  response: ResolvedMediaAnchor,
): ResolvedMediaAnchor {
  try {
    return parseResolvedMediaAnchor(response)
  } catch {
    mediaUnavailable('Resolved media anchor is invalid')
  }
}

function validateStepResponse(
  response: CanonicalFrameAnchor,
): CanonicalFrameAnchor {
  try {
    return parseCanonicalFrameAnchor(response)
  } catch {
    mediaUnavailable('Canonical frame anchor is invalid')
  }
}

export async function resolvePlaybackCursor(
  cursor: PlaybackCursor,
  identity: CursorMediaIdentity,
  deps: CursorResolutionDependencies,
): Promise<ResolvedMediaAnchor> {
  if (cursor.cursor_status !== 'ready') {
    throw new MediaHttpError(422, 'CURSOR_NOT_READY', 'Playback cursor is not ready')
  }
  const windowId = parseUuid(cursor.playback_window_id, 'Playback window')
  const window = await loadWindow(windowId, identity, deps)
  assertMappingVersion(window.mappingVersion, cursor.mapping_version)

  const observedTargetUs = window.presentationOriginCaptureUs
    + BigInt(cursor.player_media_time_us)
  if (observedTargetUs < window.captureStartUs || observedTargetUs > window.captureEndUs) {
    throw new MediaHttpError(422, 'CAPTURE_GAP', 'Cursor is outside available media')
  }
  // HTMLMediaElement may report currentTime === duration on the final frame.
  // Canonical availability stays half-open; resolve that terminal observation
  // against the last indexed instant instead of manufacturing an out-of-range
  // cursor error at normal playback completion.
  const targetUs = observedTargetUs === window.captureEndUs
    ? window.captureEndUs - 1n
    : observedTargetUs

  const mappings = mappingsForTarget(window.segments, targetUs)
  if (mappings.length === 0) {
    throw new MediaHttpError(422, 'CAPTURE_GAP', 'Cursor is outside available media')
  }
  const indexed = await loadIndexes(deps.sampleIndexes, mappings)
  const resolverStartUs = window.captureStartUs > mappings[0]!.captureStartUs
    ? window.captureStartUs
    : mappings[0]!.captureStartUs
  const resolverEndUs = window.captureEndUs < mappings.at(-1)!.captureEndUs
    ? window.captureEndUs
    : mappings.at(-1)!.captureEndUs
  let resolution: ReturnType<typeof resolveCanonicalTimeAcrossSegments>
  try {
    resolution = resolveCanonicalTimeAcrossSegments(
      indexed,
      targetUs,
      resolverStartUs,
      resolverEndUs,
    )
  } catch (error) {
    resolverFailure(error)
  }
  const segment = indexedSegment(indexed, resolution.segmentId)
  return validateResolvedResponse({
    schema_version: '1.0.0',
    playback_window_id: window.id,
    capture_session_id: window.captureSessionId,
    capture_epoch_id: resolution.epochId,
    dvr_segment_id: resolution.segmentId,
    source_pts: resolution.sample.sourcePts,
    source_time_base: wireTimeBase(segment),
    capture_time_us: resolution.sample.captureTimeUs,
    capture_frame_index: resolution.sample.captureFrameIndex,
    resolved_player_media_time_us: resolvedPlayerTime(
      resolution.sample.captureTimeUs,
      window,
    ),
    mapping_version: window.mappingVersion,
    snap_distance_us: resolution.snapDistanceUs,
    timing_precision: resolution.kind,
  })
}

function findCurrentMapping(
  mappings: readonly CursorWindowSegment[],
  captureFrameIndex: bigint,
): { mapping: CursorWindowSegment; index: number } | null {
  const matches = mappings
    .map((mapping, index) => ({ mapping, index }))
    .filter(({ mapping }) =>
      mapping.firstFrameIndex! <= captureFrameIndex
      && captureFrameIndex < mapping.firstFrameIndex! + mapping.frameCount)
  if (matches.length > 1) mediaUnavailable('Playback frame mapping is invalid')
  return matches[0] ?? null
}

function adjacentMappingIsUsable(
  current: CursorWindowSegment,
  adjacent: CursorWindowSegment,
  direction: 'previous' | 'next',
): boolean {
  if (
    adjacent.dvrProgramId !== current.dvrProgramId
    || adjacent.isGap
    || !adjacent.ready
    || adjacent.firstFrameIndex === null
  ) return false

  return direction === 'next'
    ? adjacent.sequenceNumber > current.sequenceNumber
      && adjacent.captureStartUs === current.captureEndUs
      && adjacent.firstFrameIndex
        === current.firstFrameIndex! + current.frameCount
    : adjacent.sequenceNumber < current.sequenceNumber
      && adjacent.captureEndUs === current.captureStartUs
      && adjacent.firstFrameIndex + adjacent.frameCount
        === current.firstFrameIndex
}

async function directionalMappings(input: {
  captureFrameIndex: bigint
  count: number
  direction: 'previous' | 'next'
  identity: CursorMediaIdentity
  window: CursorPlaybackWindow
  store: CursorWindowStore
}): Promise<readonly CursorWindowSegment[]> {
  const found = findCurrentMapping(
    input.window.segments,
    input.captureFrameIndex,
  )
  if (!found) {
    throw new MediaHttpError(422, 'SAMPLE_NOT_FOUND', 'Sample was not found')
  }
  const { index } = found
  const mapped = input.direction === 'next'
    ? input.window.segments.slice(index)
    : input.window.segments.slice(0, index + 1)
  const edge = input.direction === 'next' ? mapped.at(-1)! : mapped[0]!
  const targetFrameIndex = input.direction === 'next'
    ? input.captureFrameIndex + BigInt(input.count)
    : input.captureFrameIndex - BigInt(input.count)
  const needsAdjacent = input.direction === 'next'
    ? targetFrameIndex >= edge.firstFrameIndex! + edge.frameCount
    : targetFrameIndex < edge.firstFrameIndex!
  if (!needsAdjacent) return mapped

  let adjacent: CursorWindowSegment | null
  try {
    adjacent = await input.store.loadAdjacentSegment({
      direction: input.direction,
      edge,
      identity: input.identity,
      window: input.window,
    })
  } catch {
    throw new MediaHttpError(
      500,
      'MEDIA_NOT_READY',
      'Adjacent media could not be read',
    )
  }
  if (!adjacent || !adjacentMappingIsUsable(edge, adjacent, input.direction)) {
    return mapped
  }
  return input.direction === 'next'
    ? [...mapped, adjacent]
    : [adjacent, ...mapped]
}

export async function stepCanonicalFrame(
  request: FrameStepRequest,
  identity: CursorMediaIdentity,
  deps: CursorResolutionDependencies,
): Promise<CanonicalFrameAnchor> {
  const windowId = parseUuid(request.playback_window_id, 'Playback window')
  const captureSessionId = parseUuid(request.capture_session_id, 'Capture session')
  const window = await loadWindow(windowId, identity, deps)
  if (window.captureSessionId.toLowerCase() !== captureSessionId) {
    throw new MediaHttpError(404, 'NOT_FOUND', 'Playback window not found')
  }
  assertMappingVersion(window.mappingVersion, request.mapping_version)

  const captureFrameIndex = BigInt(request.capture_frame_index)
  const mappings = await directionalMappings({
    captureFrameIndex,
    count: request.count,
    direction: request.direction,
    identity,
    store: deps.store,
    window,
  })
  const indexed = await loadIndexes(deps.sampleIndexes, mappings)
  const indexedStartUs = indexed[0]!.index.availableStartUs
  const indexedEndUs = indexed.at(-1)!.index.availableEndUs
  const resolverStartUs = window.captureStartUs > indexedStartUs
    ? window.captureStartUs
    : indexedStartUs
  const resolverEndUs = window.captureEndUs < indexedEndUs
    ? window.captureEndUs
    : indexedEndUs

  let resolution: ReturnType<typeof frameStepAcrossSegments> | null = null
  let currentFrameIndex = captureFrameIndex
  for (let index = 0; index < request.count; index += 1) {
    try {
      resolution = frameStepAcrossSegments(
        indexed,
        currentFrameIndex,
        request.direction,
        resolverStartUs,
        resolverEndUs,
      )
      currentFrameIndex = BigInt(resolution.sample.captureFrameIndex)
    } catch (error) {
      resolverFailure(error)
    }
  }
  if (!resolution) mediaUnavailable('Canonical frame step count is invalid')
  const segment = indexedSegment(indexed, resolution.segmentId)
  return validateStepResponse({
    schema_version: '1.0.0',
    capture_session_id: window.captureSessionId,
    playback_window_id: window.id,
    mapping_version: window.mappingVersion,
    capture_epoch_id: resolution.epochId,
    dvr_segment_id: resolution.segmentId,
    source_pts: resolution.sample.sourcePts,
    source_time_base: wireTimeBase(segment),
    capture_time_us: resolution.sample.captureTimeUs,
    capture_frame_index: resolution.sample.captureFrameIndex,
    player_media_time_us: resolvedPlayerTime(
      resolution.sample.captureTimeUs,
      window,
    ),
    timing_precision: resolution.kind,
  })
}
