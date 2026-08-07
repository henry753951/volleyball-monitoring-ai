import type {
  FfprobeFrame,
  Rational,
} from '@volleyball-monitoring/media'
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
import {
  parseFinalizedRecording,
  type FinalizedRecording,
} from './finalized-recording.js'
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

export function probeSamples(frames: readonly FfprobeFrame[]) {
  const videoFrames = frames.filter((frame) => frame.media_type === 'video')
  if (videoFrames.length === 0) throw new Error('Finalized media has no video samples.')
  const normalized = videoFrames.map((frame) => {
    if (
      frame.pts === undefined
      || !SIGNED_DECIMAL.test(frame.pts)
      || (
        frame.key_frame !== undefined
        && frame.key_frame !== 0
        && frame.key_frame !== 1
      )
    ) throw new Error('Finalized media sample timing is invalid.')
    return {
      sourcePts: BigInt(frame.pts),
      keyframe: frame.key_frame === 1,
      packetDuration: frame.pkt_duration,
    }
  })
  return normalized.map((frame, index) => {
    const next = normalized[index + 1]
    if (!next && (
      frame.packetDuration === undefined
      || !POSITIVE_DECIMAL.test(frame.packetDuration)
    )) throw new Error('Finalized media sample timing is invalid.')
    const durationPts = next
      ? next.sourcePts - frame.sourcePts
      : BigInt(frame.packetDuration!)
    if (durationPts <= 0n) throw new Error('Finalized media sample timing is invalid.')
    return {
      sourcePts: frame.sourcePts,
      durationPts,
      keyframe: frame.keyframe,
    }
  })
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
    contentType: kind === 'sample-index'
      ? 'application/json' as const
      : 'video/mp4' as const,
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
    const artifact = authoritative.artifacts.find(
      (candidate) => candidate.kind === reservation.kind,
    )
    if (
      !artifact
      || artifact.location.bucket !== reservation.location.bucket
      || artifact.location.key !== reservation.location.key
      || artifact.contentType !== reservation.contentType
      || artifact.internalSchemaVersion !== reservation.internalSchemaVersion
    ) throw new Error('Authoritative artifact metadata conflicts with reservation.')
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
  const probeResult = await probe(
    recording.trustedPath,
    signal ? { signal } : {},
  )
  const samples = probeSamples(probeResult.frames)
  const source = await deps.source.read(
    recording,
    signal ? { signal } : {},
  )

  const ingestKey = idempotencyKey(recording, sourceContentSha256(source))
  const reservations = (['init', 'media', 'sample-index'] as const).map(
    (kind) => artifactReservation(
      deps.bucket,
      envelope.captureSessionId,
      ingestKey,
      kind,
    ),
  )
  const profile = await deps.profile(envelope.captureSessionId, {
    frameCount: BigInt(samples.length),
    timeBase: probeResult.timeBase,
    durationPts: samples.reduce(
      (duration, sample) => duration + sample.durationPts,
      0n,
    ),
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
    sourceRestart: envelope.sourceRestart,
    timestampDiscontinuity: envelope.timestampDiscontinuity,
    ...(envelope.explicitGapBeforeUs === null
      ? {}
      : { explicitGapBeforeUs: BigInt(envelope.explicitGapBeforeUs) }),
    artifacts: reservations,
  }
  const reservation = await deps.repository.reserveUploading(reservationInput)
  const authoritative = buildArtifactPlan(
    deps.bucket,
    recording,
    source,
    reservation.sampleIndex,
  )
  assertAuthoritativePlan(ingestKey, reservations, authoritative)

  const expected = metadataFor(authoritative.artifacts)
  await deps.repository.recordArtifactExpectations({
    reservation: reservation.reference,
    artifacts: expected,
    sampleIndexDocument: authoritative.sampleIndex,
  })
  for (const artifact of authoritative.artifacts) {
    await deps.store.upload(artifact)
  }
  for (const artifact of expected) await deps.store.verify(artifact)
  await deps.repository.publishReady({
    reservation: reservation.reference,
    verifiedArtifacts: expected,
  })
}
