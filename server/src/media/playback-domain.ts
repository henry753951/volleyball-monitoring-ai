import type {
  MediaApiError,
  MediaErrorCode,
  MediaMode,
  PlaybackWindowDescriptor,
} from '@volleyball-monitoring/contracts'

export const MEDIA_INTERNAL_SCHEMA_VERSION = '1.0.0' as const

export interface PlaybackSegmentCandidate {
  id: string
  captureStartUs: bigint
  captureEndUs: bigint
  durationUs: bigint
  discontinuity: number
  ready: boolean
  isGap: boolean
  initAssetId: string | null
  mediaAssetId: string | null
}

export interface ReadyPlaybackRun {
  startUs: bigint
  endUs: bigint
  discontinuity: number
  segments: PlaybackSegmentCandidate[]
}

export interface PlaybackWindowLimits {
  defaultBackUs: bigint
  defaultForwardUs: bigint
  maxBackUs: bigint
  maxForwardUs: bigint
}

export interface PlaybackWindowSelection {
  targetUs: bigint
  timelineStartUs: bigint
  timelineEndUs: bigint
  selectedRun: ReadyPlaybackRun
  segments: PlaybackSegmentCandidate[]
  windowStartUs: bigint
  windowEndUs: bigint
  hasMoreBefore: boolean
  hasMoreAfter: boolean
}

export interface SampleSnapResult {
  captureUs: bigint
  playerUs: bigint
}

export type MediaAssetKind =
  | 'DVR_INIT'
  | 'DVR_SEGMENT'
  | 'SAMPLE_INDEX'
  | 'TIMING_MANIFEST'

export interface MediaObjectReadRequest {
  bucket: string
  key: string
  expectedByteLength: bigint
  expectedSha256: string
  expectedContentType: string
  expectedInternalSchemaVersion: string
  expectedKind: MediaAssetKind
}

export type MediaObjectReader = (
  request: MediaObjectReadRequest,
) => Promise<Uint8Array>

export type PlaybackResourceKind = 'init' | 'media'

export interface PlaybackManifestSegment {
  id: string
  durationUs: bigint
  initAssetId: string
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const SHA256 = /^[0-9a-f]{64}$/i

export class MediaHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: MediaErrorCode,
    message: string,
    public readonly details: Record<string, unknown> | null = null,
  ) {
    super(message)
    this.name = 'MediaHttpError'
  }
}

export function mediaErrorEnvelope(
  error: MediaHttpError,
  requestId: string,
): MediaApiError {
  return {
    schema_version: '1.0.0',
    code: error.code,
    message: error.message,
    request_id: requestId,
    ...(error.details === null ? {} : { details: error.details }),
  }
}

function requireNonNegative(value: bigint, name: string): void {
  if (value < 0n) {
    throw new MediaHttpError(400, 'BAD_REQUEST', `${name} must be non-negative`)
  }
}

function clamp(value: bigint, maximum: bigint): bigint {
  return value > maximum ? maximum : value
}

function requestedDuration(
  value: bigint | undefined,
  fallback: bigint,
  maximum: bigint,
  name: string,
): bigint {
  const requested = value ?? fallback
  requireNonNegative(requested, name)
  return clamp(requested, maximum)
}

function assertCandidate(candidate: PlaybackSegmentCandidate): void {
  if (!UUID.test(candidate.id)) {
    throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'Invalid DVR segment identity')
  }
  if (
    candidate.captureStartUs < 0n
    || candidate.captureEndUs <= candidate.captureStartUs
    || candidate.durationUs <= 0n
    || candidate.durationUs !== candidate.captureEndUs - candidate.captureStartUs
    || candidate.discontinuity < 0
    || !Number.isSafeInteger(candidate.discontinuity)
  ) {
    throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'Invalid DVR segment timing')
  }
}

export function buildReadyPlaybackRuns(
  candidates: readonly PlaybackSegmentCandidate[],
): ReadyPlaybackRun[] {
  const runs: ReadyPlaybackRun[] = []
  let previousStartUs: bigint | null = null
  let previousEndUs: bigint | null = null
  const identities = new Set<string>()

  for (const candidate of candidates) {
    assertCandidate(candidate)
    if (identities.has(candidate.id)) {
      throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'Duplicate DVR segment identity')
    }
    identities.add(candidate.id)
    if (previousStartUs !== null && candidate.captureStartUs < previousStartUs) {
      throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'DVR segments are out of order')
    }
    if (previousEndUs !== null && candidate.captureStartUs < previousEndUs) {
      throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'DVR segment ranges overlap')
    }
    previousStartUs = candidate.captureStartUs
    previousEndUs = candidate.captureEndUs

    if (!candidate.ready || candidate.isGap) continue
    const previous = runs.at(-1)
    if (
      previous
      && previous.discontinuity === candidate.discontinuity
      && previous.endUs === candidate.captureStartUs
    ) {
      previous.endUs = candidate.captureEndUs
      previous.segments.push({ ...candidate })
      continue
    }
    runs.push({
      discontinuity: candidate.discontinuity,
      endUs: candidate.captureEndUs,
      segments: [{ ...candidate }],
      startUs: candidate.captureStartUs,
    })
  }
  return runs
}

function targetUnavailableError(
  candidates: readonly PlaybackSegmentCandidate[],
  targetUs: bigint,
): MediaHttpError {
  const containing = candidates.find((candidate) =>
    candidate.captureStartUs <= targetUs && targetUs < candidate.captureEndUs)
  if (containing?.isGap) {
    return new MediaHttpError(422, 'CAPTURE_GAP', 'Target is inside a capture gap')
  }
  if (containing && !containing.ready) {
    return new MediaHttpError(409, 'MEDIA_NOT_READY', 'Target media is not ready')
  }
  return new MediaHttpError(422, 'CAPTURE_GAP', 'Target is outside available media')
}

function runForTarget(
  runs: readonly ReadyPlaybackRun[],
  targetUs: bigint,
  mode: MediaMode,
): ReadyPlaybackRun | null {
  const exact = runs.find((run) => run.startUs <= targetUs && targetUs < run.endUs)
  if (exact) return exact
  if (mode === 'live') {
    const last = runs.at(-1)
    if (last && targetUs === last.endUs) return last
  }
  return null
}

function segmentsForBounds(
  run: ReadyPlaybackRun,
  targetUs: bigint,
  desiredStartUs: bigint,
  desiredEndUs: bigint,
): PlaybackSegmentCandidate[] {
  const selected = run.segments.filter((segment) =>
    segment.captureEndUs > desiredStartUs && segment.captureStartUs < desiredEndUs)
  if (selected.length > 0) return selected

  const containing = run.segments.find((segment) =>
    segment.captureStartUs <= targetUs && targetUs < segment.captureEndUs)
  if (containing) return [containing]
  if (targetUs === run.endUs) return [run.segments.at(-1)!]
  throw new MediaHttpError(422, 'CAPTURE_GAP', 'Target has no playable segment')
}

export function selectPlaybackWindow(input: {
  candidates: readonly PlaybackSegmentCandidate[]
  mode: MediaMode
  requestedTargetUs: bigint | null
  liveEdgeUs: bigint
  requestedBackUs?: bigint
  requestedForwardUs?: bigint
  limits: PlaybackWindowLimits
}): PlaybackWindowSelection {
  const {
    candidates,
    limits,
    liveEdgeUs,
    mode,
    requestedBackUs,
    requestedForwardUs,
  } = input
  for (const [name, value] of Object.entries(limits)) {
    requireNonNegative(value, name)
  }

  const runs = buildReadyPlaybackRuns(candidates)
  if (runs.length === 0) {
    throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'No playable media is ready')
  }
  const timelineStartUs = runs[0]!.startUs
  const timelineEndUs = runs.at(-1)!.endUs
  const targetUs = mode === 'live'
    ? (liveEdgeUs >= timelineStartUs && liveEdgeUs <= timelineEndUs
        ? liveEdgeUs
        : timelineEndUs)
    : input.requestedTargetUs
  if (targetUs === null) {
    throw new MediaHttpError(400, 'BAD_REQUEST', 'Archive target is required')
  }
  requireNonNegative(targetUs, 'target_capture_time_us')

  const selectedRun = runForTarget(runs, targetUs, mode)
  if (!selectedRun) throw targetUnavailableError(candidates, targetUs)

  const backUs = requestedDuration(
    requestedBackUs,
    limits.defaultBackUs,
    limits.maxBackUs,
    'requested_back_us',
  )
  const forwardUs = requestedDuration(
    requestedForwardUs,
    limits.defaultForwardUs,
    limits.maxForwardUs,
    'requested_forward_us',
  )
  const desiredStartUs = targetUs - backUs > selectedRun.startUs
    ? targetUs - backUs
    : selectedRun.startUs
  const uncappedEndUs = targetUs + forwardUs
  const desiredEndUs = uncappedEndUs < selectedRun.endUs
    ? uncappedEndUs
    : selectedRun.endUs
  const segments = segmentsForBounds(
    selectedRun,
    targetUs,
    desiredStartUs,
    desiredEndUs,
  )
  const windowStartUs = segments[0]!.captureStartUs
  const windowEndUs = segments.at(-1)!.captureEndUs

  return {
    hasMoreAfter: windowEndUs < timelineEndUs,
    hasMoreBefore: windowStartUs > timelineStartUs,
    segments,
    selectedRun,
    targetUs,
    timelineEndUs,
    timelineStartUs,
    windowEndUs,
    windowStartUs,
  }
}

export function presentationOriginForSnap(
  selection: PlaybackWindowSelection,
  snap: SampleSnapResult,
): bigint {
  if (
    snap.captureUs < selection.windowStartUs
    || snap.captureUs >= selection.windowEndUs
    || snap.playerUs < 0n
    || snap.playerUs > snap.captureUs
  ) {
    throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'Authoritative sample is outside the window')
  }
  const originUs = snap.captureUs - snap.playerUs
  if (originUs < selection.windowStartUs || originUs > snap.captureUs) {
    throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'Authoritative player mapping is invalid')
  }
  if (snap.playerUs > selection.windowEndUs - originUs) {
    throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'Authoritative player target exceeds the window')
  }
  return originUs
}

export function playbackResourceToken(
  kind: PlaybackResourceKind,
  dvrSegmentId: string,
): string {
  if (!UUID.test(dvrSegmentId)) {
    throw new MediaHttpError(404, 'NOT_FOUND', 'Media resource not found')
  }
  return `${kind}-${dvrSegmentId.toLowerCase()}`
}

export function parsePlaybackResourceToken(token: string): {
  kind: PlaybackResourceKind
  dvrSegmentId: string
} {
  const match = /^(init|media)-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.exec(token)
  if (!match) throw new MediaHttpError(404, 'NOT_FOUND', 'Media resource not found')
  return {
    kind: match[1]!.toLowerCase() as PlaybackResourceKind,
    dvrSegmentId: match[2]!.toLowerCase(),
  }
}

function formatDurationUs(durationUs: bigint): string {
  if (durationUs <= 0n) {
    throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'Segment duration is invalid')
  }
  const whole = durationUs / 1_000_000n
  const fraction = (durationUs % 1_000_000n)
    .toString()
    .padStart(6, '0')
    .replace(/0+$/, '')
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`
}

export function formatManifest(
  windowId: string,
  segments: readonly PlaybackManifestSegment[],
): string {
  if (!UUID.test(windowId) || segments.length === 0) {
    throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'Playback manifest is unavailable')
  }
  let maximumDurationUs = 0n
  for (const segment of segments) {
    if (segment.durationUs > maximumDurationUs) maximumDurationUs = segment.durationUs
  }
  const targetDuration = (maximumDurationUs + 999_999n) / 1_000_000n
  const base = `/api/v1/media/playback-windows/${windowId}/segments`
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${targetDuration > 0n ? targetDuration : 1n}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
  ]
  let previousInitAssetId: string | null = null
  for (const segment of segments) {
    if (!UUID.test(segment.initAssetId)) {
      throw new MediaHttpError(409, 'MEDIA_NOT_READY', 'Initialization media is unavailable')
    }
    if (segment.initAssetId !== previousInitAssetId) {
      lines.push(
        `#EXT-X-MAP:URI="${base}/${playbackResourceToken('init', segment.id)}"`,
      )
      previousInitAssetId = segment.initAssetId
    }
    lines.push(
      `#EXTINF:${formatDurationUs(segment.durationUs)},`,
      `${base}/${playbackResourceToken('media', segment.id)}`,
    )
  }
  lines.push('#EXT-X-ENDLIST')
  return `${lines.join('\n')}\n`
}

export function buildPlaybackDescriptor(input: {
  id: string
  captureSessionId: string
  mode: 'LIVE' | 'ARCHIVE'
  mappingVersion: number
  captureStartUs: bigint
  captureEndUs: bigint
  presentationOriginCaptureUs: bigint
  targetPlayerMediaTimeUs: bigint
  expiresAt: Date
  timelineStartUs: bigint
  timelineEndUs: bigint
  liveEdgeUs: bigint | null
}): PlaybackWindowDescriptor {
  return {
    schema_version: '1.0.0',
    playback_window_id: input.id,
    capture_session_id: input.captureSessionId,
    mode: input.mode === 'LIVE' ? 'live' : 'archive',
    mapping_version: input.mappingVersion,
    timeline_capture_start_us: input.timelineStartUs.toString(),
    timeline_capture_end_us: input.timelineEndUs.toString(),
    window_capture_start_us: input.captureStartUs.toString(),
    window_capture_end_us: input.captureEndUs.toString(),
    presentation_origin_capture_us: input.presentationOriginCaptureUs.toString(),
    target_player_media_time_us: input.targetPlayerMediaTimeUs.toString(),
    manifest_url: `/api/v1/media/playback-windows/${input.id}/manifest.m3u8`,
    expires_at: input.expiresAt.toISOString(),
    live_edge_capture_time_us: input.liveEdgeUs?.toString() ?? null,
    has_more_before: input.captureStartUs > input.timelineStartUs,
    has_more_after: input.captureEndUs < input.timelineEndUs,
  }
}

export function validSha256(value: string | null): value is string {
  return value !== null && SHA256.test(value)
}
