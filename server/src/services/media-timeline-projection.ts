export interface TimelineProjectionRange {
  startUs: bigint
  endUs: bigint
  discontinuity: number
}

export interface TimelineProjectionSegment {
  sequenceNumber: bigint
  captureStartUs: bigint
  captureEndUs: bigint
  discontinuitySequence: number
  isGap: boolean
  readyAt: Date | null
}

export interface TimelineProjection {
  schemaVersion: 1
  programId: string
  playlistRevision: bigint
  finalizedSequence: bigint | null
  observedSequence: bigint | null
  captureStartUs: bigint | null
  liveEdgeUs: bigint | null
  ingestFrontierUs: bigint | null
  availableRanges: TimelineProjectionRange[]
  gapRanges: TimelineProjectionRange[]
}

interface SerializedTimelineProjectionRange {
  start_us: string
  end_us: string
  discontinuity: number
}

interface SerializedTimelineProjection {
  schema_version: 1
  program_id: string
  playlist_revision: string
  finalized_sequence: string | null
  observed_sequence: string | null
  capture_start_us: string | null
  live_edge_us: string | null
  ingest_frontier_us: string | null
  available_ranges: SerializedTimelineProjectionRange[]
  gap_ranges: SerializedTimelineProjectionRange[]
}

function maximum(left: bigint | null, right: bigint): bigint {
  return left === null || right > left ? right : left
}

function appendRange(ranges: TimelineProjectionRange[], next: TimelineProjectionRange): void {
  const previous = ranges.at(-1)
  if (
    previous &&
    previous.discontinuity === next.discontinuity &&
    previous.endUs >= next.startUs
  ) {
    previous.endUs = maximum(previous.endUs, next.endUs)
    return
  }
  ranges.push({ ...next })
}

function assertSegment(segment: TimelineProjectionSegment): void {
  if (segment.sequenceNumber < 0n) throw new TypeError('timeline sequence must be non-negative')
  if (segment.captureStartUs < 0n || segment.captureEndUs <= segment.captureStartUs) {
    throw new TypeError('timeline segment has invalid bounds')
  }
  if (!Number.isSafeInteger(segment.discontinuitySequence) || segment.discontinuitySequence < 0) {
    throw new TypeError('timeline discontinuity must be a non-negative safe integer')
  }
}

export function emptyTimelineProjection(
  programId: string,
  playlistRevision: bigint,
): TimelineProjection {
  if (!programId) throw new TypeError('timeline program id is required')
  if (playlistRevision < 0n) throw new TypeError('timeline playlist revision must be non-negative')
  return {
    schemaVersion: 1,
    programId,
    playlistRevision,
    finalizedSequence: null,
    observedSequence: null,
    captureStartUs: null,
    liveEdgeUs: null,
    ingestFrontierUs: null,
    availableRanges: [],
    gapRanges: [],
  }
}

/**
 * Applies rows in sequence order. The finalized cursor stops at the first
 * unresolved media row. Ingest is FIFO, so a later READY row cannot safely be
 * exposed before that row. The observed cursor/frontier still records storage
 * progress so polling does not repeatedly scan an unchanged pending tail.
 */
export function applyTimelineSegments(
  base: TimelineProjection,
  playlistRevision: bigint,
  rows: readonly TimelineProjectionSegment[],
): TimelineProjection {
  if (playlistRevision < base.playlistRevision) {
    throw new TypeError('timeline playlist revision regressed')
  }
  const next: TimelineProjection = {
    ...base,
    playlistRevision,
    availableRanges: base.availableRanges.map(range => ({ ...range })),
    gapRanges: base.gapRanges.map(range => ({ ...range })),
  }
  let previousSequence = base.finalizedSequence
  let previousInputSequence: bigint | null = null
  let canFinalize = true

  for (const row of rows) {
    assertSegment(row)
    if (previousSequence !== null && row.sequenceNumber <= previousSequence) {
      throw new TypeError('timeline delta must follow the finalized cursor')
    }
    if (previousInputSequence !== null && row.sequenceNumber <= previousInputSequence) {
      throw new TypeError('timeline delta must be strictly ordered')
    }
    previousInputSequence = row.sequenceNumber
    next.observedSequence =
      next.observedSequence === null || row.sequenceNumber > next.observedSequence
        ? row.sequenceNumber
        : next.observedSequence
    next.ingestFrontierUs = maximum(next.ingestFrontierUs, row.captureEndUs)

    if (!canFinalize) continue
    if (!row.isGap && row.readyAt === null) {
      canFinalize = false
      continue
    }

    const range = {
      discontinuity: row.discontinuitySequence,
      endUs: row.captureEndUs,
      startUs: row.captureStartUs,
    }
    if (row.isGap) {
      appendRange(next.gapRanges, range)
    } else {
      appendRange(next.availableRanges, range)
      next.captureStartUs ??= row.captureStartUs
      next.liveEdgeUs = maximum(next.liveEdgeUs, row.captureEndUs)
    }
    next.finalizedSequence = row.sequenceNumber
    previousSequence = row.sequenceNumber
  }
  return next
}

function serializeRange(range: TimelineProjectionRange): SerializedTimelineProjectionRange {
  return {
    discontinuity: range.discontinuity,
    end_us: range.endUs.toString(),
    start_us: range.startUs.toString(),
  }
}

export function serializeTimelineProjection(projection: TimelineProjection): string {
  const value: SerializedTimelineProjection = {
    schema_version: 1,
    program_id: projection.programId,
    playlist_revision: projection.playlistRevision.toString(),
    finalized_sequence: projection.finalizedSequence?.toString() ?? null,
    observed_sequence: projection.observedSequence?.toString() ?? null,
    capture_start_us: projection.captureStartUs?.toString() ?? null,
    live_edge_us: projection.liveEdgeUs?.toString() ?? null,
    ingest_frontier_us: projection.ingestFrontierUs?.toString() ?? null,
    available_ranges: projection.availableRanges.map(serializeRange),
    gap_ranges: projection.gapRanges.map(serializeRange),
  }
  return JSON.stringify(value)
}

function parseBigInt(value: unknown, field: string, nullable = false): bigint | null {
  if (nullable && value === null) return null
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`invalid cached timeline ${field}`)
  }
  return BigInt(value)
}

function parseRanges(value: unknown, field: string): TimelineProjectionRange[] {
  if (!Array.isArray(value)) throw new TypeError(`invalid cached timeline ${field}`)
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') {
      throw new TypeError(`invalid cached timeline ${field}[${index}]`)
    }
    const range = candidate as Partial<SerializedTimelineProjectionRange>
    if (!Number.isSafeInteger(range.discontinuity) || (range.discontinuity ?? -1) < 0) {
      throw new TypeError(`invalid cached timeline ${field}[${index}].discontinuity`)
    }
    const startUs = parseBigInt(range.start_us, `${field}[${index}].start_us`)!
    const endUs = parseBigInt(range.end_us, `${field}[${index}].end_us`)!
    if (endUs <= startUs) throw new TypeError(`invalid cached timeline ${field}[${index}] bounds`)
    return { discontinuity: range.discontinuity!, endUs, startUs }
  })
}

export function parseTimelineProjection(serialized: string): TimelineProjection {
  const value = JSON.parse(serialized) as Partial<SerializedTimelineProjection>
  if (value.schema_version !== 1 || typeof value.program_id !== 'string' || !value.program_id) {
    throw new TypeError('invalid cached timeline envelope')
  }
  return {
    schemaVersion: 1,
    programId: value.program_id,
    playlistRevision: parseBigInt(value.playlist_revision, 'playlist_revision')!,
    finalizedSequence: parseBigInt(value.finalized_sequence, 'finalized_sequence', true),
    observedSequence: parseBigInt(value.observed_sequence, 'observed_sequence', true),
    captureStartUs: parseBigInt(value.capture_start_us, 'capture_start_us', true),
    liveEdgeUs: parseBigInt(value.live_edge_us, 'live_edge_us', true),
    ingestFrontierUs: parseBigInt(value.ingest_frontier_us, 'ingest_frontier_us', true),
    availableRanges: parseRanges(value.available_ranges, 'available_ranges'),
    gapRanges: parseRanges(value.gap_ranges, 'gap_ranges'),
  }
}
