import type { AnalysisData } from '@volleyball-monitoring/contracts'
import { describe, expect, it } from 'vitest'
import {
  buildAnalysisDataDatasetFiles,
  buildPersistedReidDatasetFiles,
  ML_DATASET_README,
  redactAiJobRequest,
} from '../src/media/analysis-dataset.js'

const analysisData: AnalysisData = {
  schemaVersion: 10_000,
  aiJobId: 'job-1',
  rallySubmissionId: 'submission-1',
  rallyId: 'rally-1',
  matchId: 'match-1',
  annotationRevision: 7n,
  clipAssetId: 'clip-1',
  analysisId: 'analysis-1',
  analysisVersion: 'rtv4-test',
  videoWidth: 1920,
  videoHeight: 1080,
  fpsNum: 60,
  fpsDen: 1,
  totalFrames: 2n,
  frameOffsets: [0, 1, 1],
  trackIds: [12],
  frameBboxes: [{ x1: 0, y1: 16_384, x2: 32_767, y2: 65_534 }],
  frameFootPositions: [{ x: 32_767, y: 65_534 }],
  courtPositions: [{ x: -0.25, y: 1.4 }],
  playerFlags: [7],
  playerConfidences: [127],
  actionTaxonomyId: 'actions',
  actionTaxonomyVersion: '1',
  actionLabels: ['serve'],
  actionLabelIds: [0],
  actionConfidences: [254],
  ballFramePositions: [
    { x: 65_534, y: 0 },
    { x: 0, y: 0 },
  ],
  ballFlags: [1, 0],
  ballConfidences: [254, 255],
  courtKeypointFrameOffsets: [0, 1, 1],
  courtKeypointIds: [4],
  courtKeypointPositions: [{ x: 16_384, y: 32_767 }],
  courtKeypointConfidences: [127],
  domainJson: JSON.stringify({ contact_events: [], path_segments: [] }),
  inputClipSha256: 'a'.repeat(64),
  producerName: 'fixture-provider',
  producerBuildId: 'fixture-build',
  producerSdkVersion: '1.0.0',
  executionManifestJson: '{}',
}

function rows(files: ReturnType<typeof buildAnalysisDataDatasetFiles>, path: string) {
  const file = files.find(item => item.path === path)
  if (!file) throw new Error(`missing ${path}`)
  return file.bytes
    .toString('utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

function payload(files: ReturnType<typeof buildPersistedReidDatasetFiles>, path: string) {
  const file = files.find(item => item.path === path)
  if (!file) throw new Error(`missing ${path}`)
  return JSON.parse(file.bytes.toString('utf8')) as Record<string, any>
}

describe('ML analysis dataset', () => {
  it('decodes every persisted AnalysisData column with canonical timestamps and exact quantized values', () => {
    const files = buildAnalysisDataDatasetFiles(analysisData, {
      captureEpochId: ['epoch', 'epoch'],
      captureFrameIndex: [60n, 61n],
      captureTimeUs: [1_000_000n, 1_016_667n],
      captureEndUs: 1_033_334n,
      clipTimeUs: [0n, 16_667n],
      clipEndUs: 33_334n,
      sourcePts: [30n, 31n],
    })

    expect(rows(files, 'tables/frames.jsonl')).toEqual([
      { frame_index: '0', clip_time_us: '0', capture_time_us: '1000000' },
      { frame_index: '1', clip_time_us: '16667', capture_time_us: '1016667' },
    ])
    expect(rows(files, 'predictions/players.jsonl')[0]).toMatchObject({
      frame_index: '0',
      track_id: 12,
      frame_bbox_quantized_u16: { x1: 0, y1: 16_384, x2: 32_767, y2: 65_534 },
      court_pos: { x: -0.25, y: 1.4 },
      confidence_quantized_u8: 127,
    })
    expect(rows(files, 'predictions/actions.jsonl')).toEqual([
      expect.objectContaining({ label: 'serve', confidence: 1 }),
    ])
    expect(rows(files, 'predictions/ball.jsonl')).toEqual([
      expect.objectContaining({ frame_index: '0', state: 'observed', frame_pos: { x: 1, y: 0 } }),
      expect.objectContaining({
        frame_index: '1',
        state: 'missing',
        frame_pos: null,
        confidence: null,
      }),
    ])
    expect(rows(files, 'predictions/court-keypoints.jsonl')[0]).toMatchObject({
      keypoint_id: 4,
      frame_pos_quantized_u16: { x: 16_384, y: 32_767 },
    })
  })

  it('redacts callback credentials without mutating ML inputs', () => {
    const request = {
      ai_job_id: 'job-1',
      key_points: [{ frame_index: '12' }],
      callback: { url: 'https://central/callback', token: 'secret-token' },
    }
    expect(redactAiJobRequest(request)).toEqual({
      ai_job_id: 'job-1',
      key_points: [{ frame_index: '12' }],
      callback: { url: 'https://central/callback', token: '[REDACTED]' },
    })
    expect(request.callback.token).toBe('secret-token')
  })

  it('rejects a timing table that cannot align one-to-one with AnalysisData frames', () => {
    expect(() =>
      buildAnalysisDataDatasetFiles(analysisData, {
        captureEpochId: ['epoch'],
        captureFrameIndex: [60n],
        captureTimeUs: [1n],
        captureEndUs: 2n,
        clipTimeUs: [0n],
        clipEndUs: 1n,
        sourcePts: [30n],
      }),
    ).toThrow('AnalysisData and timing frame counts differ')
  })

  it('exports versioned ReID evidence, active projections, and correction lineage', () => {
    const rosterEntry = {
      id: 'roster-1',
      teamId: 'team-1',
      playerId: 'player-1',
      displayNameSnapshot: 'Player One',
      jerseyNumber: '11',
      position: 'OH',
      active: true,
      player: { id: 'player-1', name: 'Player One' },
      team: { id: 'team-1', name: 'Blue Team' },
    }
    const files = buildPersistedReidDatasetFiles({
      analysisRunId: 'run-1',
      matchId: 'match-1',
      matchIdentityRevision: 8n,
      descriptorBundlePaths: {
        'evidence-1': 'reid/evidence/evidence-1-descriptors.bin',
      },
      tracklets: [
        {
          id: 'tracklet-1',
          evidenceSetId: 'evidence-1',
          canonicalTrackId: 12,
          trackIdAliases: [12, 19],
          courtSide: 'LEFT',
          firstFrameIndex: 2n,
          lastFrameIndex: 42n,
          cannotLinkTrackletIds: ['tracklet-2'],
          createdAt: new Date('2026-08-13T00:00:30.000Z'),
          evidenceSet: {
            id: 'evidence-1',
            schemaVersion: '1.0.0',
            recipeNamespace: 'nested-part-v2',
            contentSha256: 'a'.repeat(64),
            status: 'READY',
          },
          vectors: [
            {
              id: 'vector-1',
              modality: 'osnet',
              modelNamespace: 'sports-osnet-v1',
              dimension: 512,
              normalization: 'l2',
              distance: 'cosine',
              byteOffset: 2_048n,
              byteLength: 2_048n,
              sha256: 'b'.repeat(64),
              sourceFrameIndices: [2n, 12n, 42n],
              createdAt: new Date('2026-08-13T00:00:31.000Z'),
            },
          ],
          activeProjection: {
            sourcePriority: 1_000,
            assignmentRevision: {
              id: 'assignment-8',
              source: 'MANUAL',
              revision: 8n,
              effectiveFromSetNumber: 1,
              effectiveFromRallyOrdinal: 2,
              correctionId: 'correction-1',
              createdAt: new Date('2026-08-13T00:03:00.000Z'),
              personCluster: { id: 'cluster-2', teamId: 'team-1', label: 'P2' },
              rosterEntry,
            },
          },
        },
      ],
      corrections: [
        {
          id: 'correction-1',
          matchId: 'match-1',
          teamId: 'team-1',
          analysisRunId: 'run-1',
          trackletId: 'tracklet-1',
          sourcePersonClusterId: 'cluster-1',
          targetPersonClusterId: 'cluster-2',
          rosterEntryId: 'roster-1',
          displayScope: 'CURRENT_CLIP',
          futureEvidenceAction: 'REJECT_SOURCE_AND_CONFIRM_TARGET',
          revision: 8n,
          reason: 'human review',
          createdAt: new Date('2026-08-13T00:03:00.000Z'),
          sourcePersonCluster: { id: 'cluster-1', teamId: 'team-1', label: 'P1' },
          targetPersonCluster: { id: 'cluster-2', teamId: 'team-1', label: 'P2' },
          rosterEntry,
        },
      ],
    })

    const evidence = payload(files, 'reid/evidence-tracklets.jsonl')
    expect(evidence).toMatchObject({
      schema_version: '3.0.0',
      match_identity_revision: '8',
      canonical_track_id: 12,
      evidence_set: { id: 'evidence-1', recipe_namespace: 'nested-part-v2' },
      vectors: [
        expect.objectContaining({
          modality: 'osnet',
          artifact_ref: {
            path: 'reid/evidence/evidence-1-descriptors.bin',
            byte_offset: '2048',
            byte_length: '2048',
            sha256: 'b'.repeat(64),
          },
        }),
      ],
    })

    const projection = payload(files, 'reid/active-projections.jsonl')
    expect(projection).toMatchObject({
      canonical_track_id: 12,
      manual_assignment_required: false,
      active_projection: {
        person_cluster: { id: 'cluster-2', label: 'P2' },
        roster_entry: { player_name: 'Player One' },
        revision: '8',
      },
    })

    const lineageText = files
      .find(item => item.path === 'reid/correction-lineage.jsonl')!
      .bytes.toString('utf8')
    expect(JSON.parse(lineageText)).toMatchObject({
      snapshot_identity_revision: '8',
      revision: '8',
      source_person_cluster: { id: 'cluster-1' },
      target_person_cluster: { id: 'cluster-2' },
      future_evidence_action: 'reject_source_and_confirm_target',
    })
    expect(lineageText).not.toContain('user-secret')
    expect(ML_DATASET_README).toContain('SHA-256')
  })
})
