import { join } from 'node:path'
import {
  planNextCaptureSegment,
  type PersistedCaptureHead,
} from '../packages/media/src/epoch-planner.ts'
import { runFfprobe } from '../worker/src/media/ffprobe.ts'
import { probeSamples } from '../worker/src/media/ingest-handler.ts'
import { scanSpool } from '../worker/src/media/indexer-runtime.ts'

const spoolRoot = process.argv[2]
const ingestPath = process.argv[3] ?? 'gate/main'
const captureSessionId = process.argv[4] ?? '00000000-0000-4000-8000-000000000001'

if (!spoolRoot)
  throw new Error(
    'usage: bun scripts/verify_media_reconnect.ts <spool-root> [ingest-path] [capture-session-id]',
  )

const envelopes = await scanSpool(spoolRoot, async path =>
  path === ingestPath ? captureSessionId : null,
)
if (envelopes.length < 2)
  throw new Error(`expected at least two finalized segments, received ${envelopes.length}`)

const restartIndexes = envelopes.flatMap((envelope, index) =>
  envelope.sourceRestart ? [index] : [],
)
if (restartIndexes.length !== 1 || restartIndexes[0] === 0) {
  throw new Error(
    `expected exactly one persisted reconnect boundary after the first segment, received ${restartIndexes.join(',') || 'none'}`,
  )
}

let head: PersistedCaptureHead | null = null
let previousCaptureEndUs: bigint | null = null
let previousFrameEnd: bigint | null = null
let previousDiscontinuity: number | null = null
const evidence: Array<Record<string, unknown>> = []

for (const [index, envelope] of envelopes.entries()) {
  const probe = await runFfprobe(join(spoolRoot, ...envelope.candidate.split('/')))
  const samples = probeSamples(probe.frames, probe.streamEndPtsExclusive)
  const plan = planNextCaptureSegment({
    currentHead: head,
    newEpochId: envelope.epochCandidateId,
    segment: {
      segmentIdentity: envelope.candidate,
      sourceIdentity: ingestPath,
      sourceOrder: BigInt(envelope.sourceOrder),
      timeBase: probe.timeBase,
      samples,
    },
    sourceRestart: envelope.sourceRestart,
    timestampDiscontinuity: envelope.timestampDiscontinuity,
    ...(envelope.explicitGapBeforeUs === null
      ? {}
      : { explicitGapBeforeUs: BigInt(envelope.explicitGapBeforeUs) }),
    config: {
      canonicalSessionOriginUs: 0n,
      canonicalFrameOrigin: 0n,
      timestampToleranceUs: 250_000n,
    },
  })

  if (previousCaptureEndUs !== null && plan.segment.captureStartUs < previousCaptureEndUs) {
    throw new Error(`canonical capture time regressed at ${envelope.candidate}`)
  }
  if (previousFrameEnd !== null && plan.segment.firstFrameIndex !== previousFrameEnd) {
    throw new Error(`canonical frame sequence is not contiguous at ${envelope.candidate}`)
  }
  if (
    envelope.sourceRestart &&
    (!plan.epoch.reasons.includes('SOURCE_RESTART') || plan.epoch.disposition !== 'CREATE_NEXT')
  ) {
    throw new Error(`reconnect did not create an explicit capture epoch at ${envelope.candidate}`)
  }
  if (previousDiscontinuity === null) {
    if (plan.epoch.discontinuity !== 0) throw new Error('first playback discontinuity must be zero')
  } else {
    const expectedDiscontinuity = envelope.sourceRestart
      ? previousDiscontinuity + 1
      : previousDiscontinuity
    if (plan.epoch.discontinuity !== expectedDiscontinuity) {
      throw new Error(
        `unexpected playback discontinuity at ${envelope.candidate}: expected ${expectedDiscontinuity}, received ${plan.epoch.discontinuity}`,
      )
    }
  }

  const lastCaptureFrameIndex = plan.segment.firstFrameIndex + plan.segment.frameCount - 1n
  head = {
    epochId: plan.epoch.epochKey,
    epochSequence: plan.epoch.epochSequence,
    discontinuity: plan.epoch.discontinuity,
    timeBase: plan.epoch.timeBase,
    sourcePtsOrigin: plan.epoch.sourcePtsOrigin,
    captureTimeOriginUs: plan.epoch.captureTimeOriginUs,
    captureFrameOrigin: plan.epoch.captureFrameOrigin,
    lastSourcePtsEndExclusive: plan.segment.sourcePtsEndExclusive,
    lastCaptureEndUs: plan.segment.captureEndUs,
    lastCaptureFrameIndex,
  }
  previousCaptureEndUs = plan.segment.captureEndUs
  previousFrameEnd = lastCaptureFrameIndex + 1n
  previousDiscontinuity = plan.epoch.discontinuity
  evidence.push({
    index,
    candidate: envelope.candidate,
    source_restart: envelope.sourceRestart,
    time_base: `${probe.timeBase.num}/${probe.timeBase.den}`,
    source_first_pts: samples[0]!.sourcePts.toString(),
    source_last_pts: samples.at(-1)!.sourcePts.toString(),
    sample_count: samples.length,
    epoch_sequence: plan.epoch.epochSequence,
    discontinuity_sequence: plan.epoch.discontinuity,
    epoch_reasons: plan.epoch.reasons,
    capture_start_us: plan.segment.captureStartUs.toString(),
    capture_end_us: plan.segment.captureEndUs.toString(),
    first_capture_frame_index: plan.segment.firstFrameIndex.toString(),
    last_capture_frame_index: lastCaptureFrameIndex.toString(),
  })
}

process.stdout.write(
  `${JSON.stringify(
    {
      schema_version: '1.0.0',
      capture_session_id: captureSessionId,
      ingest_path: ingestPath,
      reconnect_segment_index: restartIndexes[0],
      segment_count: envelopes.length,
      final_capture_time_us: previousCaptureEndUs!.toString(),
      final_capture_frame_count: previousFrameEnd!.toString(),
      segments: evidence,
    },
    null,
    2,
  )}\n`,
)
