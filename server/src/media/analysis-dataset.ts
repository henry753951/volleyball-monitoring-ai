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
export const REID_DATASET_SCHEMA_VERSION = '3.0.0'

export interface ReidRosterEntrySnapshot {
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

export interface ReidFeatureVectorSnapshot {
  id: string
  modality: string
  modelNamespace: string
  dimension: number
  normalization: string
  distance: string
  byteOffset: bigint
  byteLength: bigint
  sha256: string
  sourceFrameIndices: bigint[]
  createdAt: Date
}

export interface ReidTrackletSnapshot {
  id: string
  evidenceSetId: string
  canonicalTrackId: number
  trackIdAliases: number[]
  courtSide: string
  firstFrameIndex: bigint
  lastFrameIndex: bigint
  cannotLinkTrackletIds: string[]
  createdAt: Date
  vectors: ReidFeatureVectorSnapshot[]
  evidenceSet: {
    id: string
    schemaVersion: string
    recipeNamespace: string
    contentSha256: string
    status: string
  }
  activeProjection: {
    sourcePriority: number
    assignmentRevision: {
      id: string
      source: string
      revision: bigint
      effectiveFromSetNumber: number
      effectiveFromRallyOrdinal: number
      correctionId: string | null
      createdAt: Date
      personCluster: {
        id: string
        teamId: string | null
        label: string | null
      } | null
      rosterEntry: ReidRosterEntrySnapshot | null
    }
  } | null
}

export interface ReidCorrectionSnapshot {
  id: string
  matchId: string
  teamId: string | null
  analysisRunId: string
  trackletId: string
  sourcePersonClusterId: string | null
  targetPersonClusterId: string | null
  rosterEntryId: string | null
  displayScope: string
  futureEvidenceAction: string
  revision: bigint
  reason: string | null
  createdAt: Date
  sourcePersonCluster: { id: string; teamId: string | null; label: string | null } | null
  targetPersonCluster: { id: string; teamId: string | null; label: string | null } | null
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
  return Buffer.from(
    rows.map(row => JSON.stringify(row, jsonReplacer)).join('\n') + (rows.length ? '\n' : ''),
  )
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function personClusterReference(
  cluster: { id: string; teamId: string | null; label: string | null } | null,
) {
  return cluster
    ? {
        id: cluster.id,
        team_id: cluster.teamId,
        label: cluster.label,
      }
    : null
}

function reidRosterEntry(entry: ReidRosterEntrySnapshot | null) {
  return entry
    ? {
        id: entry.id,
        team_id: entry.teamId,
        team_name: entry.team.name,
        player_id: entry.playerId,
        player_name: entry.displayNameSnapshot ?? entry.player?.name ?? null,
        jersey_number: entry.jerseyNumber,
        position: entry.position,
        active: entry.active,
      }
    : null
}

function compareBigint(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function buildPersistedReidDatasetFiles(input: {
  analysisRunId: string
  matchId: string
  matchIdentityRevision: bigint
  tracklets: readonly ReidTrackletSnapshot[]
  corrections: readonly ReidCorrectionSnapshot[]
  descriptorBundlePaths: Readonly<Record<string, string>>
}): GeneratedDatasetFile[] {
  const tracklets = [...input.tracklets]
    .sort((left, right) => left.canonicalTrackId - right.canonicalTrackId)
    .map(tracklet => ({
      id: tracklet.id,
      analysis_run_id: input.analysisRunId,
      evidence_set: {
        id: tracklet.evidenceSet.id,
        schema_version: tracklet.evidenceSet.schemaVersion,
        recipe_namespace: tracklet.evidenceSet.recipeNamespace,
        content_sha256: tracklet.evidenceSet.contentSha256,
        status: tracklet.evidenceSet.status.toLowerCase(),
      },
      canonical_track_id: tracklet.canonicalTrackId,
      track_id_aliases: tracklet.trackIdAliases,
      court_side: tracklet.courtSide.toLowerCase(),
      frame_range: {
        first_frame_index: tracklet.firstFrameIndex,
        last_frame_index: tracklet.lastFrameIndex,
      },
      cannot_link_tracklet_ids: tracklet.cannotLinkTrackletIds,
      vectors: tracklet.vectors.map(vector => ({
        id: vector.id,
        modality: vector.modality,
        model_namespace: vector.modelNamespace,
        dimension: vector.dimension,
        normalization: vector.normalization,
        distance: vector.distance,
        artifact_ref: {
          path: input.descriptorBundlePaths[tracklet.evidenceSetId] ?? null,
          byte_offset: vector.byteOffset,
          byte_length: vector.byteLength,
          sha256: vector.sha256,
        },
        source_frame_indices: vector.sourceFrameIndices,
        created_at: vector.createdAt,
      })),
      created_at: tracklet.createdAt,
    }))

  const projections = [...input.tracklets]
    .sort((left, right) => left.canonicalTrackId - right.canonicalTrackId)
    .map(tracklet => {
      const projection = tracklet.activeProjection?.assignmentRevision ?? null
      return {
        analysis_run_id: input.analysisRunId,
        tracklet_id: tracklet.id,
        canonical_track_id: tracklet.canonicalTrackId,
        manual_assignment_required: !projection?.rosterEntry,
        active_projection: projection
          ? {
              assignment_revision_id: projection.id,
              person_cluster: personClusterReference(projection.personCluster),
              roster_entry: reidRosterEntry(projection.rosterEntry),
              source: projection.source.toLowerCase(),
              source_priority: tracklet.activeProjection!.sourcePriority,
              revision: projection.revision,
              effective_from: {
                set_number: projection.effectiveFromSetNumber,
                rally_ordinal: projection.effectiveFromRallyOrdinal,
              },
              correction_id: projection.correctionId,
              created_at: projection.createdAt,
            }
          : null,
      }
    })

  const corrections = [...input.corrections]
    .sort(
      (left, right) =>
        compareBigint(left.revision, right.revision) ||
        left.createdAt.getTime() - right.createdAt.getTime(),
    )
    .map(correction => ({
      id: correction.id,
      match_id: correction.matchId,
      team_id: correction.teamId,
      analysis_run_id: correction.analysisRunId,
      tracklet_id: correction.trackletId,
      display_scope: correction.displayScope.toLowerCase(),
      future_evidence_action: correction.futureEvidenceAction.toLowerCase(),
      revision: correction.revision,
      source_person_cluster: personClusterReference(correction.sourcePersonCluster),
      target_person_cluster: personClusterReference(correction.targetPersonCluster),
      roster_entry_id: correction.rosterEntryId,
      roster_entry: reidRosterEntry(correction.rosterEntry),
      reason: correction.reason,
      created_at: correction.createdAt,
    }))

  return [
    {
      path: 'reid/evidence-tracklets.jsonl',
      bytes: jsonLines(
        tracklets.map(tracklet => ({
          schema_version: REID_DATASET_SCHEMA_VERSION,
          match_identity_revision: input.matchIdentityRevision,
          ...tracklet,
        })),
      ),
      contentType: 'application/x-ndjson',
      description:
        'Immutable versioned ReID tracklets and checksummed descriptor byte-range references.',
    },
    {
      path: 'reid/active-projections.jsonl',
      bytes: jsonLines(
        projections.map(projection => ({
          schema_version: REID_DATASET_SCHEMA_VERSION,
          match_id: input.matchId,
          match_identity_revision: input.matchIdentityRevision,
          ...projection,
        })),
      ),
      contentType: 'application/x-ndjson',
      description:
        'Current versioned person-cluster and roster projection for each canonical tracklet.',
    },
    {
      path: 'reid/correction-lineage.jsonl',
      bytes: jsonLines(
        corrections.map(correction => ({
          schema_version: REID_DATASET_SCHEMA_VERSION,
          snapshot_identity_revision: input.matchIdentityRevision,
          ...correction,
        })),
      ),
      contentType: 'application/x-ndjson',
      description:
        'Append-only human correction lineage and future-evidence policy without actor account identifiers.',
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
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      key === 'token' || key === 'bearer_token' || key === 'callback_token'
        ? '[REDACTED]'
        : redactAiJobRequest(item),
    ]),
  )
}

export function buildAnalysisDataDatasetFiles(
  analysisData: AnalysisData,
  timeline: ClipFrameTimeline | null,
): GeneratedDatasetFile[] {
  const totalFrames = Number(analysisData.totalFrames)
  if (!Number.isSafeInteger(totalFrames))
    throw new RangeError('AnalysisData frame count is outside the supported range')
  if (timeline && timeline.clipTimeUs.length !== totalFrames)
    throw new RangeError('AnalysisData and timing frame counts differ')

  const frames: unknown[] = []
  const players: unknown[] = []
  const actions: unknown[] = []
  const balls: unknown[] = []
  const courtKeypoints: unknown[] = []

  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
    const frameTiming = timing(frameIndex, timeline)
    frames.push(frameTiming)
    for (
      let index = analysisData.frameOffsets[frameIndex]!;
      index < analysisData.frameOffsets[frameIndex + 1]!;
      index += 1
    ) {
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
        frame_bbox:
          flags & ANALYSIS_PLAYER_FLAG.frameBBox
            ? {
                x1: frameCoordinate(rawBBox.x1),
                y1: frameCoordinate(rawBBox.y1),
                x2: frameCoordinate(rawBBox.x2),
                y2: frameCoordinate(rawBBox.y2),
              }
            : null,
        frame_bbox_quantized_u16: flags & ANALYSIS_PLAYER_FLAG.frameBBox ? rawBBox : null,
        frame_foot_pos:
          flags & ANALYSIS_PLAYER_FLAG.frameFootPosition
            ? { x: frameCoordinate(rawFoot.x), y: frameCoordinate(rawFoot.y) }
            : null,
        frame_foot_pos_quantized_u16:
          flags & ANALYSIS_PLAYER_FLAG.frameFootPosition ? rawFoot : null,
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
      frame_pos:
        ballFlags & ANALYSIS_BALL_FLAG.framePosition
          ? { x: frameCoordinate(rawBall.x), y: frameCoordinate(rawBall.y) }
          : null,
      frame_pos_quantized_u16: ballFlags & ANALYSIS_BALL_FLAG.framePosition ? rawBall : null,
      confidence: confidence(ballConfidence),
      confidence_quantized_u8: ballConfidence,
      flags: ballFlags,
    })

    for (
      let index = analysisData.courtKeypointFrameOffsets[frameIndex]!;
      index < analysisData.courtKeypointFrameOffsets[frameIndex + 1]!;
      index += 1
    ) {
      const rawPosition = analysisData.courtKeypointPositions[index]!
      const rawConfidence =
        analysisData.courtKeypointConfidences[index] ?? ANALYSIS_MISSING_CONFIDENCE
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
    {
      path: 'tables/frames.jsonl',
      bytes: jsonLines(frames),
      contentType: 'application/x-ndjson',
      description: 'Canonical frame index with clip and capture timestamps.',
    },
    {
      path: 'predictions/players.jsonl',
      bytes: jsonLines(players),
      contentType: 'application/x-ndjson',
      description:
        'Every persisted per-frame player observation decoded from authoritative AnalysisData.',
    },
    {
      path: 'predictions/ball.jsonl',
      bytes: jsonLines(balls),
      contentType: 'application/x-ndjson',
      description: 'Every canonical frame with observed or missing ball state.',
    },
    {
      path: 'predictions/court-keypoints.jsonl',
      bytes: jsonLines(courtKeypoints),
      contentType: 'application/x-ndjson',
      description: 'Every persisted court keypoint observation.',
    },
    {
      path: 'predictions/actions.jsonl',
      bytes: jsonLines(actions),
      contentType: 'application/x-ndjson',
      description: 'Every persisted per-track action prediction.',
    },
    {
      path: 'events/contacts.jsonl',
      bytes: jsonLines(
        (JSON.parse(analysisData.domainJson) as { contact_events?: unknown[] }).contact_events ??
          [],
      ),
      contentType: 'application/x-ndjson',
      description: 'AI contact proposals and hit ownership before human correction.',
    },
    {
      path: 'events/ball-paths.jsonl',
      bytes: jsonLines(
        (JSON.parse(analysisData.domainJson) as { path_segments?: unknown[] }).path_segments ?? [],
      ),
      contentType: 'application/x-ndjson',
      description: 'AI-derived ball path segments before human correction.',
    },
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
- \`reid/evidence-tracklets.jsonl\`: immutable versioned tracklets with checksummed descriptor byte-range references; it never duplicates vector bytes.
- \`reid/active-projections.jsonl\`: the current versioned person-cluster and roster projection for every canonical tracklet. Unresolved rows remain explicit.
- \`reid/correction-lineage.jsonl\`: match-wide human identity correction lineage through the exported \`snapshot_identity_revision\`; actor account identifiers are intentionally omitted.
- \`reid/evidence/*-descriptors.bin\` and \`*-result.json\`: immutable Provider Work evidence artifacts included by checksum when present.
- \`analysis/database-view.json\`: normalized server-ingested events, tracks, paths, identities, and effective correction links.
- \`analysis/timing-manifest.json\`: authoritative clip timing/PTS evidence.
- \`manifest.json\`: dataset schema version plus SHA-256 and byte length for every included source and generated file. Verify these checksums before training.

## Coordinate and time rules

Video-space coordinates are normalized to [0,1]. Their exact quantized U16 values are retained beside them. Court coordinates are AI-owned metric/canonical values and are never clamped. Confidence is decoded from U8/254; 255 means missing and is exported as null. All 64-bit frame/time/PTS values are decimal strings.

Use \`frame_index\` as the primary join key. Do not infer frame timing from nominal FPS when \`clip_time_us\` or the timing manifest is available.

## Reproducibility boundary

The archive includes the canonical clip, source/cut/timing metadata, authoritative AnalysisData, generated JSONL tables, human review state, immutable ReID evidence artifacts, current active projections, correction lineage, job/run metadata, and checksums. AnalysisData remains base-analysis evidence and does not embed cross-clip identity state. Generated tracklet, projection, correction, and label JSONL files reference artifact checksums without duplicating vectors. Transient GPU state is excluded.
`
