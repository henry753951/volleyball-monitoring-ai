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

  it('exports reproducible persisted ReID labels without duplicating vectors or actor identities', () => {
    const prototype = new Uint8Array(2_048).fill(7)
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
    const identity = {
      id: 'gid-1',
      label: 'S1',
      slotIndex: 1,
      teamId: 'team-1',
      modelNamespace: 'namespace-1',
      createdRevision: 2n,
      createdAt: new Date('2026-08-13T00:00:00.000Z'),
      bindings: [
        {
          id: 'binding-current',
          rosterEntryId: 'roster-1',
          sourceObservationId: 'observation-0',
          effectiveFromSetNumber: 1,
          effectiveFromRallyOrdinal: 1,
          source: 'MANUAL',
          identityRevision: 3n,
          createdAt: new Date('2026-08-13T00:01:00.000Z'),
          rosterEntry,
        },
        {
          id: 'binding-future',
          rosterEntryId: null,
          sourceObservationId: 'observation-future',
          effectiveFromSetNumber: 2,
          effectiveFromRallyOrdinal: 1,
          source: 'MANUAL',
          identityRevision: 8n,
          createdAt: new Date('2026-08-13T00:02:00.000Z'),
          rosterEntry: null,
        },
      ],
    }
    const files = buildPersistedReidDatasetFiles({
      analysisRunId: 'run-1',
      matchId: 'match-1',
      matchIdentityRevision: 8n,
      featureBankPath: 'reid/fixed-roster-tracklets.json',
      observations: [
        {
          id: 'observation-1',
          analysisRunId: 'run-1',
          trackId: 12,
          matchId: 'match-1',
          teamId: 'team-1',
          reidIdentityId: 'gid-1',
          modelNamespace: 'namespace-1',
          modelName: 'sports-osnet',
          modelCheckpointSha256: 'a'.repeat(64),
          modelPreprocessVersion: 'roi-align-rgb-imagenet-v1',
          modelDimension: 512,
          modelDistance: 'cosine',
          courtSide: 'LEFT',
          provisionalGid: 'L1',
          canonicalTrackId: 12,
          isCanonicalTrack: true,
          aliasTrackIds: [12],
          medianCourtX: 0.25,
          medianCourtY: 0.5,
          descriptorRecipe: { name: 'nested-part-adaptation', version: '1.0.0' },
          dinoDescriptor: new Uint8Array(384 * 4).fill(1),
          osnetDescriptor: prototype,
          kprDescriptor: new Uint8Array(4096 * 4).fill(2),
          kprPromptDescriptor: new Uint8Array(4096 * 4).fill(3),
          promptCoverage: 0.75,
          selectedModalities: ['kpr_prompt'],
          selectedKernel: 'linear',
          selectedRegularization: 0.1,
          firstFrame: 2n,
          lastFrame: 42n,
          sampleCount: 5,
          meanQuality: 0.91,
          prototype,
          cannotLinkTrackIds: [13],
          setNumber: 1,
          rallyOrdinal: 2,
          matchConfidence: 0.95,
          identityRevision: 2n,
          createdAt: new Date('2026-08-13T00:00:30.000Z'),
          reidIdentity: identity,
        },
      ],
      corrections: [
        {
          id: 'correction-1',
          matchId: 'match-1',
          teamId: 'team-1',
          analysisRunId: 'run-1',
          trackId: 12,
          sourceIdentityId: 'gid-1',
          targetIdentityId: 'gid-2',
          rosterEntryId: 'roster-1',
          kind: 'SPLIT_IDENTITY',
          identityRevision: 8n,
          details: {
            replaced_track_ids: [9],
            reassociated_observation_ids: ['observation-2'],
            token: 'must-not-export',
            created_by_user_id: 'user-secret',
          },
          createdAt: new Date('2026-08-13T00:03:00.000Z'),
          sourceIdentity: identity,
          targetIdentity: { ...identity, id: 'gid-2', label: 'S2', slotIndex: 2 },
          rosterEntry,
        },
      ],
    })

    const observations = payload(files, 'reid/persisted-observations.jsonl')
    expect(observations).toMatchObject({
      schema_version: '2.0.0',
      match_identity_revision: '8',
      feature_vectors_are_stored_only_in: 'reid/fixed-roster-tracklets.json',
      track_id: 12,
      gid: { id: 'gid-1', label: 'S1', slot_index: 1, model_namespace: 'namespace-1' },
      nested_part_adaptation: {
        selected_modalities: ['kpr_prompt'],
        selected_kernel: 'linear',
        selected_regularization: 0.1,
        feature_vector_ref: { path: 'reid/fixed-roster-tracklets.json', canonical_track_id: 12 },
      },
    })
    expect(JSON.stringify(observations)).not.toContain('prototype":[')

    const bindings = payload(files, 'reid/effective-bindings.jsonl')
    expect(bindings).toMatchObject({
      track_id: 12,
      manual_assignment_required: false,
      effective_binding: { id: 'binding-current', roster_entry: { player_name: 'Player One' } },
    })

    const lineageText = files
      .find(item => item.path === 'reid/correction-lineage.jsonl')!
      .bytes.toString('utf8')
    expect(JSON.parse(lineageText)).toMatchObject({
      snapshot_identity_revision: '8',
      identity_revision: '8',
      source_gid: { id: 'gid-1' },
      target_gid: { id: 'gid-2' },
      details: { replaced_track_ids: [9], reassociated_observation_ids: ['observation-2'] },
    })
    expect(lineageText).not.toContain('must-not-export')
    expect(lineageText).not.toContain('user-secret')
    expect(ML_DATASET_README).toContain('SHA-256')
  })
})
