import { rescalePtsToUs, type FfprobeFrame, type Rational } from '@volleyball-monitoring/media'
import {
  INTERNAL_MEDIA_SCHEMA_VERSION,
  buildArtifactPlan,
  idempotencyKey,
  metadataFor,
  planObjectLocation,
  sourceContentSha256,
  sourceIdentityHash,
  type ArtifactKind,
  type ArtifactSourceBytes,
} from './artifacts.js'
import { parseFinalizedRecording, type FinalizedRecording } from './finalized-recording.js'
import { runFfprobe, type ProbeOptions } from './ffprobe.js'
import {
  MediaIngestEnvelope as MediaIngestEnvelopeSchema,
  type MediaIngestEnvelope,
} from './indexer-runtime.js'
import type { MediaObjectStore } from './ingest.js'
import type {
  DvrProgramProfile,
  FinalizedSegmentReservationInput,
  PrismaIngestRepository,
} from './prisma-ingest-repository.js'

const SIGNED_DECIMAL = /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/

export type ProbeResult = {
  frames: FfprobeFrame[]
  timeBase: Rational
  streamEndPtsExclusive?: bigint
}

export type IngestArtifactSource = {
  read(
    recording: FinalizedRecording,
    options?: { signal?: AbortSignal },
  ): Promise<ArtifactSourceBytes>
}

export type HandlerDeps = {
  spoolRoot: string
  bucket: string
  repository: Pick<
    PrismaIngestRepository,
    'reserveUploading' | 'recordArtifactExpectations' | 'publishReady'
  >
  store: MediaObjectStore
  source: IngestArtifactSource
  probe?: (path: string, options: ProbeOptions) => Promise<ProbeResult>
  profile: (
    captureSessionId: string,
    observed: {
      frameCount: bigint
      timeBase: Rational
      durationPts: bigint
    },
  ) => Promise<DvrProgramProfile>
}

type FinalizedMediaProbeErrorCode = 'NO_VIDEO_SAMPLES' | 'INVALID_SAMPLE_TIMING'

export type PlaybackFragmentProjection = {
  byteOffset: bigint
  byteLength: bigint
  durationUs: bigint
}

function deterministicProbeError(
  code: FinalizedMediaProbeErrorCode,
  message: string,
): Error & { code: FinalizedMediaProbeErrorCode; permanent: true; retryable: true } {
  return Object.assign(new Error(message), {
    code,
    permanent: true as const,
    retryable: true as const,
  })
}

export function probeSamples(frames: readonly FfprobeFrame[], streamEndPtsExclusive?: bigint) {
  const videoFrames = frames.filter(frame => frame.media_type === 'video')
  if (videoFrames.length === 0) {
    throw deterministicProbeError('NO_VIDEO_SAMPLES', 'Finalized media has no video samples.')
  }
  const normalized = videoFrames.map(frame => {
    if (
      frame.pts === undefined ||
      !SIGNED_DECIMAL.test(frame.pts) ||
      (frame.key_frame !== undefined && frame.key_frame !== 0 && frame.key_frame !== 1)
    ) {
      throw deterministicProbeError(
        'INVALID_SAMPLE_TIMING',
        'Finalized media sample timing is invalid.',
      )
    }
    return {
      sourcePts: BigInt(frame.pts),
      keyframe: frame.key_frame === 1,
      packetDuration: frame.pkt_duration,
    }
  })
  return normalized.map((frame, index) => {
    const next = normalized[index + 1]
    const packetDuration =
      frame.packetDuration !== undefined && POSITIVE_DECIMAL.test(frame.packetDuration)
        ? BigInt(frame.packetDuration)
        : null
    const durationPts = next
      ? next.sourcePts - frame.sourcePts
      : (packetDuration ??
        (streamEndPtsExclusive === undefined ? 0n : streamEndPtsExclusive - frame.sourcePts))
    if (durationPts <= 0n) {
      throw deterministicProbeError(
        'INVALID_SAMPLE_TIMING',
        'Finalized media sample timing is invalid.',
      )
    }
    if (
      !next &&
      packetDuration !== null &&
      streamEndPtsExclusive !== undefined &&
      frame.sourcePts + packetDuration !== streamEndPtsExclusive
    ) {
      throw deterministicProbeError(
        'INVALID_SAMPLE_TIMING',
        'Finalized media sample timing is invalid.',
      )
    }
    return {
      sourcePts: frame.sourcePts,
      durationPts,
      keyframe: frame.keyframe,
    }
  })
}

/**
 * Pair fMP4 moof/mdat byte ranges with video GOP timing. A mismatched layout
 * remains playable as one physical extent; it is never published as a corrupt
 * byte-range playlist.
 */
export function projectPlaybackFragments(
  source: ArtifactSourceBytes,
  samples: readonly ReturnType<typeof probeSamples>[number][],
  timeBase: Rational,
): readonly PlaybackFragmentProjection[] | undefined {
  const ranges = source.mediaFragments
  if (!ranges?.length || samples.length === 0) return undefined
  return projectPlaybackFragmentRanges(
    ranges,
    BigInt(source.mediaBytes.byteLength),
    samples,
    timeBase,
  )
}

export function projectPlaybackFragmentRanges(
  ranges: readonly { byteOffset: bigint; byteLength: bigint }[],
  mediaByteLength: bigint,
  samples: readonly { sourcePts: bigint; durationPts: bigint; keyframe: boolean }[],
  timeBase: Rational,
): readonly PlaybackFragmentProjection[] | undefined {
  if (ranges.length === 0 || samples.length === 0 || mediaByteLength <= 0n) return undefined
  const keyframeIndexes = samples.flatMap((sample, index) => (sample.keyframe ? [index] : []))
  if (keyframeIndexes[0] !== 0 || ranges.length < keyframeIndexes.length) return undefined

  // FFmpeg can emit a tiny trailing moof/mdat when the final audio samples
  // outlive the last video GOP. It has no corresponding video keyframe and
  // belongs to the final logical HLS fragment.
  const logicalRanges = ranges.slice(0, keyframeIndexes.length).map(range => ({ ...range }))
  if (ranges.length > logicalRanges.length) {
    const final = logicalRanges.at(-1)!
    let end = final.byteOffset + final.byteLength
    for (const trailing of ranges.slice(logicalRanges.length)) {
      if (trailing.byteOffset !== end) return undefined
      end += trailing.byteLength
    }
    final.byteLength = end - final.byteOffset
  }

  const originPts = samples[0]!.sourcePts
  const endPts = samples.at(-1)!.sourcePts + samples.at(-1)!.durationPts
  const projected = logicalRanges.map((range, index) => {
    const startPts = samples[keyframeIndexes[index]!]!.sourcePts
    const nextIndex = keyframeIndexes[index + 1]
    const fragmentEndPts = nextIndex === undefined ? endPts : samples[nextIndex]!.sourcePts
    return {
      byteOffset: range.byteOffset,
      byteLength: range.byteLength,
      durationUs:
        rescalePtsToUs(fragmentEndPts - originPts, timeBase) -
        rescalePtsToUs(startPts - originPts, timeBase),
    }
  })
  let previousEnd = 0n
  for (const fragment of projected) {
    if (
      fragment.byteOffset < previousEnd ||
      fragment.byteLength <= 0n ||
      fragment.byteOffset + fragment.byteLength > mediaByteLength ||
      fragment.durationUs <= 0n
    ) {
      return undefined
    }
    previousEnd = fragment.byteOffset + fragment.byteLength
  }
  return projected
}

function artifactReservation(
  bucket: string,
  captureSessionId: string,
  ingestKey: string,
  kind: ArtifactKind,
) {
  return {
    kind,
    location: planObjectLocation(bucket, captureSessionId, ingestKey, kind),
    contentType: kind === 'sample-index' ? ('application/json' as const) : ('video/mp4' as const),
    internalSchemaVersion: INTERNAL_MEDIA_SCHEMA_VERSION,
  }
}

function assertAuthoritativePlan(
  ingestKey: string,
  reservations: readonly ReturnType<typeof artifactReservation>[],
  authoritative: ReturnType<typeof buildArtifactPlan>,
): void {
  if (authoritative.idempotencyKey !== ingestKey) {
    throw new Error('Authoritative artifact identity conflicts with reservation.')
  }
  for (const reservation of reservations) {
    const artifact = authoritative.artifacts.find(candidate => candidate.kind === reservation.kind)
    if (
      !artifact ||
      artifact.location.bucket !== reservation.location.bucket ||
      artifact.location.key !== reservation.location.key ||
      artifact.contentType !== reservation.contentType ||
      artifact.internalSchemaVersion !== reservation.internalSchemaVersion
    )
      throw new Error('Authoritative artifact metadata conflicts with reservation.')
  }
}

export async function ingestEnvelope(
  envelopeValue: MediaIngestEnvelope,
  deps: HandlerDeps,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw signal.reason
  const envelope = MediaIngestEnvelopeSchema.parse(envelopeValue)
  const recording = await parseFinalizedRecording({
    spoolRoot: deps.spoolRoot,
    candidate: envelope.candidate,
    captureSessionId: envelope.captureSessionId,
    finalized: true,
  })
  const probe = deps.probe ?? runFfprobe
  const probeResult = await probe(recording.trustedPath, signal ? { signal } : {})
  const samples = probeSamples(probeResult.frames, probeResult.streamEndPtsExclusive)
  const source = await deps.source.read(recording, signal ? { signal } : {})
  const playbackFragments = projectPlaybackFragments(source, samples, probeResult.timeBase)

  const ingestKey = idempotencyKey(recording, sourceContentSha256(source))
  const reservations = (['init', 'media', 'sample-index'] as const).map(kind =>
    artifactReservation(deps.bucket, envelope.captureSessionId, ingestKey, kind),
  )
  const profile = await deps.profile(envelope.captureSessionId, {
    frameCount: BigInt(samples.length),
    timeBase: probeResult.timeBase,
    durationPts: samples.reduce((duration, sample) => duration + sample.durationPts, 0n),
  })
  const reservationInput: FinalizedSegmentReservationInput = {
    captureSessionId: envelope.captureSessionId,
    idempotencyKey: ingestKey,
    sourceIdentityHash: sourceIdentityHash(recording),
    newEpochId: envelope.epochCandidateId,
    programProfile: profile,
    sourceOrder: BigInt(envelope.sourceOrder),
    timeBase: probeResult.timeBase,
    samples,
    ...(playbackFragments ? { playbackFragments } : {}),
    sourceRestart: envelope.sourceRestart,
    timestampDiscontinuity: envelope.timestampDiscontinuity,
    ...(envelope.explicitGapBeforeUs === null
      ? {}
      : { explicitGapBeforeUs: BigInt(envelope.explicitGapBeforeUs) }),
    artifacts: reservations,
    extent: {
      sourceJobId: envelope.epochCandidateId,
      localPath: recording.sourceIdentity,
      finalizedAt: new Date(Number(recording.mtimeNs / 1_000_000n)),
    },
  }
  const reservation = await deps.repository.reserveUploading(reservationInput)
  const authoritative = buildArtifactPlan(deps.bucket, recording, source, reservation.sampleIndex)
  assertAuthoritativePlan(ingestKey, reservations, authoritative)

  const expected = metadataFor(authoritative.artifacts)
  await deps.repository.recordArtifactExpectations({
    reservation: reservation.reference,
    artifacts: expected,
    sampleIndexDocument: authoritative.sampleIndex,
  })
  // All object keys are immutable and independent once the reservation is
  // committed. Upload and verify them concurrently so a segment does not pay
  // six serial object-store round trips. Publication remains the single
  // atomic visibility boundary after every artifact has been verified.
  await Promise.all(authoritative.artifacts.map(artifact => deps.store.upload(artifact)))
  await Promise.all(expected.map(artifact => deps.store.verify(artifact)))
  await deps.repository.publishReady({
    reservation: reservation.reference,
    verifiedArtifacts: expected,
    extent: reservationInput.extent!,
  })
}
