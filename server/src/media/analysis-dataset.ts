import {
  ANALYSIS_BALL_FLAG,
  ANALYSIS_MISSING_ACTION_LABEL,
  ANALYSIS_MISSING_CONFIDENCE,
  ANALYSIS_PLAYER_FLAG,
  type AnalysisData,
} from '@volleyball-monitoring/contracts'
import { createHash } from 'node:crypto'
import type { ClipFrameTimeline } from './clip-timing-coverage.js'

const QUANTIZED_FRAME_MAX = 65_534
const QUANTIZED_CONFIDENCE_MAX = 254

export interface GeneratedDatasetFile {
  path: string
  bytes: Buffer
  contentType: string
  description: string
}

export const ML_DATASET_SCHEMA_VERSION = '1.3.0'
export const REID_DATASET_SCHEMA_VERSION = '1.0.0'

interface ReidRosterEntrySnapshot {
  id: string
  teamId: string
  playerId: string | null
  displayNameSnapshot: string | null
  jerseyNumber: string | null
  position: string | null
  active: boolean
  player: { id: string; name: string } | null
  team: { id: string; name: string }
}

interface ReidPlayerBindingSnapshot {
  id: string
  rosterEntryId: string | null
  sourceObservationId: string | null
  effectiveFromSetNumber: number
  effectiveFromRallyOrdinal: number
  source: string
  identityRevision: bigint
  createdAt: Date
  rosterEntry: ReidRosterEntrySnapshot | null
}

interface ReidIdentitySnapshot {
  id: string
  label: string
  teamId: string
  modelNamespace: string
  createdRevision: bigint
  createdAt: Date
  bindings: ReidPlayerBindingSnapshot[]
}

export interface ReidObservationSnapshot {
  id: string
  analysisRunId: string
  trackId: number
  matchId: string
  teamId: string | null
  reidIdentityId: string | null
  modelNamespace: string
  modelName: string
  modelCheckpointSha256: string
  modelPreprocessVersion: string
  modelDimension: number
  modelDistance: string
  courtSide: string
  provisionalGid: string
  firstFrame: bigint
  lastFrame: bigint
  sampleCount: number
  meanQuality: number
  prototype: Uint8Array
  cannotLinkTrackIds: number[]
  setNumber: number
  rallyOrdinal: number
  matchConfidence: number | null
  identityRevision: bigint
  createdAt: Date
  reidIdentity: ReidIdentitySnapshot | null
}

interface ReidIdentityReference {
  id: string
  label: string
  teamId: string
  modelNamespace: string
}

export interface ReidCorrectionSnapshot {
  id: string
  matchId: string
  teamId: string
  analysisRunId: string | null
  trackId: number | null
  sourceIdentityId: string | null
  targetIdentityId: string | null
  rosterEntryId: string | null
  kind: string
  identityRevision: bigint
  details: unknown
  createdAt: Date
  sourceIdentity: ReidIdentityReference | null
  targetIdentity: ReidIdentityReference | null
  rosterEntry: ReidRosterEntrySnapshot | null
}

function jsonReplacer(_key: string, value: unknown) {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  return value
}

export function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, jsonReplacer, 2)}\n`)
}

export function jsonLines(rows: readonly unknown[]): Buffer {
  return Buffer.from(rows.map(row => JSON.stringify(row, jsonReplacer)).join('\n') + (rows.length ? '\n' : ''))
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function reidIdentityReference(identity: ReidIdentityReference | null) {
  return identity ? {
    id: identity.id,
    label: identity.label,
    team_id: identity.teamId,
    model_namespace: identity.modelNamespace,
  } : null
}

function reidRosterEntry(entry: ReidRosterEntrySnapshot | null) {
  return entry ? {
    id: entry.id,
    team_id: entry.teamId,
    team_name: entry.team.name,
    player_id: entry.playerId,
    player_name: entry.displayNameSnapshot ?? entry.player?.name ?? null,
    jersey_number: entry.jerseyNumber,
    position: entry.position,
    active: entry.active,
  } : null
}

function bindingAppliesAt(binding: ReidPlayerBindingSnapshot, observation: ReidObservationSnapshot): boolean {
  return binding.effectiveFromSetNumber < observation.setNumber
    || (binding.effectiveFromSetNumber === observation.setNumber && binding.effectiveFromRallyOrdinal <= observation.rallyOrdinal)
}

function compareBigint(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function effectiveBinding(observation: ReidObservationSnapshot): ReidPlayerBindingSnapshot | null {
  return [...(observation.reidIdentity?.bindings ?? [])]
    .filter(binding => bindingAppliesAt(binding, observation))
    .sort((left, right) => right.effectiveFromSetNumber - left.effectiveFromSetNumber
      || right.effectiveFromRallyOrdinal - left.effectiveFromRallyOrdinal
      || compareBigint(right.identityRevision, left.identityRevision)
      || right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null
}

function safeCorrectionDetails(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const replacedTrackIds = Array.isArray(record.replaced_track_ids)
    ? record.replaced_track_ids.filter((entry): entry is number => Number.isInteger(entry) && Number(entry) >= 0)
    : []
  const reassociatedObservationIds = Array.isArray(record.reassociated_observation_ids)
    ? record.reassociated_observation_ids.filter((entry): entry is string => typeof entry === 'string')
    : []
  return { replaced_track_ids: replacedTrackIds, reassociated_observation_ids: reassociatedObservationIds }
}

export function buildPersistedReidDatasetFiles(input: {
  analysisRunId: string
  matchId: string
  matchIdentityRevision: bigint
  observations: readonly ReidObservationSnapshot[]
  corrections: readonly ReidCorrectionSnapshot[]
  featureBankPath: string | null
}): GeneratedDatasetFile[] {
  const observations = [...input.observations].sort((left, right) => left.trackId - right.trackId).map(observation => ({
    id: observation.id,
    analysis_run_id: observation.analysisRunId,
    track_id: observation.trackId,
    match_id: observation.matchId,
    team_id: observation.teamId,
    gid: reidIdentityReference(observation.reidIdentity),
    provisional_gid: observation.provisionalGid,
    court_side: observation.courtSide.toLowerCase(),
    frame_range: { first_frame_index: observation.firstFrame, last_frame_index: observation.lastFrame },
    sample_count: observation.sampleCount,
    mean_quality: observation.meanQuality,
    cannot_link_track_ids: observation.cannotLinkTrackIds,
    canonical_position: { set_number: observation.setNumber, rally_ordinal: observation.rallyOrdinal },
    match_confidence: observation.matchConfidence,
    identity_revision: observation.identityRevision,
    model: {
      namespace: observation.modelNamespace,
      name: observation.modelName,
      checkpoint_sha256: observation.modelCheckpointSha256,
      preprocess_version: observation.modelPreprocessVersion,
      dimension: observation.modelDimension,
      distance: observation.modelDistance,
    },
    persisted_prototype: {
      encoding: 'float32_le',
      byte_length: observation.prototype.byteLength,
      sha256: sha256Bytes(observation.prototype),
      feature_vector_ref: input.featureBankPath ? {
        path: input.featureBankPath,
        court_side: observation.courtSide.toLowerCase(),
        track_id: observation.trackId,
      } : null,
    },
    created_at: observation.createdAt,
  }))

  const bindings = [...input.observations].sort((left, right) => left.trackId - right.trackId).map(observation => {
    const binding = effectiveBinding(observation)
    return {
      analysis_run_id: observation.analysisRunId,
      track_id: observation.trackId,
      gid: reidIdentityReference(observation.reidIdentity),
      canonical_position: { set_number: observation.setNumber, rally_ordinal: observation.rallyOrdinal },
      manual_assignment_required: !binding?.rosterEntryId,
      effective_binding: binding ? {
        id: binding.id,
        roster_entry_id: binding.rosterEntryId,
        source_observation_id: binding.sourceObservationId,
        effective_from: {
          set_number: binding.effectiveFromSetNumber,
          rally_ordinal: binding.effectiveFromRallyOrdinal,
        },
        source: binding.source,
        identity_revision: binding.identityRevision,
        roster_entry: reidRosterEntry(binding.rosterEntry),
        created_at: binding.createdAt,
      } : null,
    }
  })

  const corrections = [...input.corrections]
    .sort((left, right) => compareBigint(left.identityRevision, right.identityRevision) || left.createdAt.getTime() - right.createdAt.getTime())
    .map(correction => ({
      id: correction.id,
      match_id: correction.matchId,
      team_id: correction.teamId,
      analysis_run_id: correction.analysisRunId,
      track_id: correction.trackId,
      kind: correction.kind,
      identity_revision: correction.identityRevision,
      source_gid: reidIdentityReference(correction.sourceIdentity),
      target_gid: reidIdentityReference(correction.targetIdentity),
      roster_entry_id: correction.rosterEntryId,
      roster_entry: reidRosterEntry(correction.rosterEntry),
      details: safeCorrectionDetails(correction.details),
      created_at: correction.createdAt,
    }))

  return [
    {
      path: 'reid/persisted-observations.jsonl',
      bytes: jsonLines(observations.map(observation => ({ schema_version: REID_DATASET_SCHEMA_VERSION, match_identity_revision: input.matchIdentityRevision, feature_vectors_are_stored_only_in: input.featureBankPath, ...observation }))),
      contentType: 'application/x-ndjson',
      description: 'Persisted clip ReID observations, GID labels, model namespace, prototype checksums, and feature-bank references without duplicating vectors.',
    },
    {
      path: 'reid/effective-bindings.jsonl',
      bytes: jsonLines(bindings.map(binding => ({ schema_version: REID_DATASET_SCHEMA_VERSION, match_id: input.matchId, match_identity_revision: input.matchIdentityRevision, ...binding }))),
      contentType: 'application/x-ndjson',
      description: 'Effective GID-to-roster labels at this clip canonical position, including explicit unresolved/manual-required rows.',
    },
    {
      path: 'reid/correction-lineage.jsonl',
      bytes: jsonLines(corrections.map(correction => ({ schema_version: REID_DATASET_SCHEMA_VERSION, snapshot_identity_revision: input.matchIdentityRevision, ...correction }))),
      contentType: 'application/x-ndjson',
      description: 'Versioned match identity correction lineage without actor account identifiers or arbitrary sensitive detail fields.',
    },
  ]
}

function confidence(value: number): number | null {
  return value === ANALYSIS_MISSING_CONFIDENCE ? null : value / QUANTIZED_CONFIDENCE_MAX
}

function frameCoordinate(value: number): number {
  return value / QUANTIZED_FRAME_MAX
}

function timing(frameIndex: number, timeline: ClipFrameTimeline | null) {
  return {
    frame_index: String(frameIndex),
    clip_time_us: timeline?.clipTimeUs[frameIndex]?.toString() ?? null,
    capture_time_us: timeline?.captureTimeUs[frameIndex]?.toString() ?? null,
  }
}

export function redactAiJobRequest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAiJobRequest)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    key === 'token' || key === 'bearer_token' || key === 'callback_token' ? '[REDACTED]' : redactAiJobRequest(item),
  ]))
}

export function buildAnalysisDataDatasetFiles(
  analysisData: AnalysisData,
  timeline: ClipFrameTimeline | null,
): GeneratedDatasetFile[] {
  const totalFrames = Number(analysisData.totalFrames)
  if (!Number.isSafeInteger(totalFrames)) throw new RangeError('AnalysisData frame count is outside the supported range')
  if (timeline && timeline.clipTimeUs.length !== totalFrames) throw new RangeError('AnalysisData and timing frame counts differ')

  const frames: unknown[] = []
  const players: unknown[] = []
  const actions: unknown[] = []
  const balls: unknown[] = []
  const courtKeypoints: unknown[] = []

  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
    const frameTiming = timing(frameIndex, timeline)
    frames.push(frameTiming)
    for (let index = analysisData.frameOffsets[frameIndex]!; index < analysisData.frameOffsets[frameIndex + 1]!; index += 1) {
      const flags = analysisData.playerFlags[index] ?? 0
      const rawBBox = analysisData.frameBboxes[index]!
      const rawFoot = analysisData.frameFootPositions[index]!
      const rawCourt = analysisData.courtPositions[index]!
      const rawConfidence = analysisData.playerConfidences[index] ?? ANALYSIS_MISSING_CONFIDENCE
      const actionId = analysisData.actionLabelIds[index] ?? ANALYSIS_MISSING_ACTION_LABEL
      const actionConfidence = analysisData.actionConfidences[index] ?? ANALYSIS_MISSING_CONFIDENCE
      const common = { ...frameTiming, track_id: analysisData.trackIds[index]! }
      players.push({
        ...common,
        frame_bbox: flags & ANALYSIS_PLAYER_FLAG.frameBBox
          ? { x1: frameCoordinate(rawBBox.x1), y1: frameCoordinate(rawBBox.y1), x2: frameCoordinate(rawBBox.x2), y2: frameCoordinate(rawBBox.y2) }
          : null,
        frame_bbox_quantized_u16: flags & ANALYSIS_PLAYER_FLAG.frameBBox ? rawBBox : null,
        frame_foot_pos: flags & ANALYSIS_PLAYER_FLAG.frameFootPosition
          ? { x: frameCoordinate(rawFoot.x), y: frameCoordinate(rawFoot.y) }
          : null,
        frame_foot_pos_quantized_u16: flags & ANALYSIS_PLAYER_FLAG.frameFootPosition ? rawFoot : null,
        court_pos: flags & ANALYSIS_PLAYER_FLAG.courtPosition ? rawCourt : null,
        confidence: confidence(rawConfidence),
        confidence_quantized_u8: rawConfidence,
        flags,
      })
      if (actionId !== ANALYSIS_MISSING_ACTION_LABEL) {
        actions.push({
          ...common,
          taxonomy_id: analysisData.actionTaxonomyId,
          taxonomy_version: analysisData.actionTaxonomyVersion,
          label_id: actionId,
          label: analysisData.actionLabels[actionId] ?? null,
          confidence: confidence(actionConfidence),
          confidence_quantized_u8: actionConfidence,
        })
      }
    }

    const rawBall = analysisData.ballFramePositions[frameIndex]!
    const ballFlags = analysisData.ballFlags[frameIndex] ?? 0
    const ballConfidence = analysisData.ballConfidences[frameIndex] ?? ANALYSIS_MISSING_CONFIDENCE
    balls.push({
      ...frameTiming,
      state: ballFlags & ANALYSIS_BALL_FLAG.framePosition ? 'observed' : 'missing',
      frame_pos: ballFlags & ANALYSIS_BALL_FLAG.framePosition
        ? { x: frameCoordinate(rawBall.x), y: frameCoordinate(rawBall.y) }
        : null,
      frame_pos_quantized_u16: ballFlags & ANALYSIS_BALL_FLAG.framePosition ? rawBall : null,
      confidence: confidence(ballConfidence),
      confidence_quantized_u8: ballConfidence,
      flags: ballFlags,
    })

    for (let index = analysisData.courtKeypointFrameOffsets[frameIndex]!; index < analysisData.courtKeypointFrameOffsets[frameIndex + 1]!; index += 1) {
      const rawPosition = analysisData.courtKeypointPositions[index]!
      const rawConfidence = analysisData.courtKeypointConfidences[index] ?? ANALYSIS_MISSING_CONFIDENCE
      courtKeypoints.push({
        ...frameTiming,
        keypoint_id: analysisData.courtKeypointIds[index]!,
        frame_pos: { x: frameCoordinate(rawPosition.x), y: frameCoordinate(rawPosition.y) },
        frame_pos_quantized_u16: rawPosition,
        confidence: confidence(rawConfidence),
        confidence_quantized_u8: rawConfidence,
      })
    }
  }

  return [
    { path: 'tables/frames.jsonl', bytes: jsonLines(frames), contentType: 'application/x-ndjson', description: 'Canonical frame index with clip and capture timestamps.' },
    { path: 'predictions/players.jsonl', bytes: jsonLines(players), contentType: 'application/x-ndjson', description: 'Every persisted per-frame player observation decoded from authoritative AnalysisData.' },
    { path: 'predictions/ball.jsonl', bytes: jsonLines(balls), contentType: 'application/x-ndjson', description: 'Every canonical frame with observed or missing ball state.' },
    { path: 'predictions/court-keypoints.jsonl', bytes: jsonLines(courtKeypoints), contentType: 'application/x-ndjson', description: 'Every persisted court keypoint observation.' },
    { path: 'predictions/actions.jsonl', bytes: jsonLines(actions), contentType: 'application/x-ndjson', description: 'Every persisted per-track action prediction.' },
    { path: 'events/contacts.jsonl', bytes: jsonLines((JSON.parse(analysisData.domainJson) as { contact_events?: unknown[] }).contact_events ?? []), contentType: 'application/x-ndjson', description: 'AI contact proposals and hit ownership before human correction.' },
    { path: 'events/ball-paths.jsonl', bytes: jsonLines((JSON.parse(analysisData.domainJson) as { path_segments?: unknown[] }).path_segments ?? []), contentType: 'application/x-ndjson', description: 'AI-derived ball path segments before human correction.' },
  ]
}

export const ML_DATASET_README = `# Volleyball analysis ML experiment bundle

This archive is a versioned snapshot of one canonical rally clip and every AI output persisted by the central system.

## Start here

- \`video/clip.mp4\`: immutable canonical input clip; it is not re-encoded during export.
- \`input/ai-job-request.redacted.json\`: persisted inference input; callback delivery credentials are omitted or redacted.
- \`analysis/analysis-data.vad1\`: the single authoritative AnalysisData FlatBuffer, including event and frame data.
- \`predictions/*.jsonl\`: ML-friendly decoded player, ball, court, and action tables.
- \`events/*.jsonl\`: contact ownership and ball-path records decoded from AnalysisData.
- \`tables/frames.jsonl\`: joins every prediction to canonical frame, clip time, and capture time.
- \`labels/*.jsonl\`: sparse human corrections and identity assignments; these override predictions at the same key.
- \`reid/clip-feature-bank.json\`: versioned Sports OSNet track prototypes, quality, frame bounds, and cannot-link evidence when the Worker produced ReID features.
- \`reid/persisted-observations.jsonl\`: central persistence rows for each clip track, including GID, model namespace, prototype checksum, and the exact feature-bank reference. It never duplicates feature vectors.
- \`reid/effective-bindings.jsonl\`: GID-to-roster labels effective at this clip's set/rally position. Unresolved rows are retained with \`manual_assignment_required: true\`.
- \`reid/correction-lineage.jsonl\`: match-wide human identity correction lineage through the exported \`snapshot_identity_revision\`; actor account identifiers are intentionally omitted.
- \`analysis/database-view.json\`: normalized server-ingested events, tracks, paths, identities, and effective correction links.
- \`analysis/timing-manifest.json\`: authoritative clip timing/PTS evidence.
- \`manifest.json\`: dataset schema version plus SHA-256 and byte length for every included source and generated file. Verify these checksums before training.

## Coordinate and time rules

Video-space coordinates are normalized to [0,1]. Their exact quantized U16 values are retained beside them. Court coordinates are AI-owned metric/canonical values and are never clamped. Confidence is decoded from U8/254; 255 means missing and is exported as null. All 64-bit frame/time/PTS values are decimal strings.

Use \`frame_index\` as the primary join key. Do not infer frame timing from nominal FPS when \`clip_time_us\` or the timing manifest is available.

## Reproducibility boundary

The archive includes the canonical clip, its source/cut/timing metadata, authoritative AnalysisData, generated JSONL tables, human review state, identity assignments, versioned ReID track prototypes, current effective roster bindings, correction lineage, job/run metadata, and checksums. The authoritative AnalysisData embeds the ReID feature bank, and \`reid/clip-feature-bank.json\` is an exact extracted view for ML tooling. Generated observation, binding, correction, and label JSONL files reference prototype checksums without duplicating vectors. Per-frame detector embeddings are intentionally reduced to track prototypes; transient GPU tensors, feature maps, process memory, and worker-local debug previews/logs are not part of the online inference contract.
`
