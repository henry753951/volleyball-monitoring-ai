import { describe, expect, it } from 'vitest'
import {
  buildReidBankSnapshot,
  buildReidRosterSnapshot,
  featureRecipeNamespace,
  verifiedSemanticContentSha,
} from '../src/services/reid-artifacts.js'

describe('immutable ReID input artifacts', () => {
  it('builds a deterministic submission-scoped roster with explicit court sides', () => {
    const input = {
      snapshotId: 'roster/20000000-0000-4000-8000-000000000001',
      matchId: '20000000-0000-4000-8000-000000000002',
      submissionId: '20000000-0000-4000-8000-000000000003',
      setNumber: 2,
      rallyOrdinal: 17,
      leftTeamId: '20000000-0000-4000-8000-000000000004',
      rightTeamId: '20000000-0000-4000-8000-000000000005',
      entries: [
        {
          id: '20000000-0000-4000-8000-000000000006',
          teamId: '20000000-0000-4000-8000-000000000004',
          playerId: null,
          jerseyNumber: '11',
          displayNameSnapshot: 'P11',
          position: 'OH',
          active: true,
        },
        {
          id: '20000000-0000-4000-8000-000000000007',
          teamId: '20000000-0000-4000-8000-000000000005',
          playerId: null,
          jerseyNumber: '2',
          displayNameSnapshot: null,
          position: 'L',
          active: true,
        },
      ],
    }
    const first = buildReidRosterSnapshot(input)
    const second = buildReidRosterSnapshot({ ...input, entries: [...input.entries].reverse() })
    expect(second).toEqual(first)
    expect(first.teams.map(team => team.court_side)).toEqual(['LEFT', 'RIGHT'])
    expect(verifiedSemanticContentSha(first, 'roster')).toBe(first.content_sha256)
  })

  it('versions feature sets by frame selection and exact requested model namespaces', () => {
    const recipes = [{ modality: 'DINO', model_namespace: 'dino/v1' }]
    const first = featureRecipeNamespace('frames/v1', recipes)
    expect(featureRecipeNamespace('frames/v1', recipes)).toBe(first)
    expect(featureRecipeNamespace('frames/v2', recipes)).not.toBe(first)
    expect(
      featureRecipeNamespace('frames/v1', [{ modality: 'DINO', model_namespace: 'dino/v2' }]),
    ).not.toBe(first)
  })

  it('makes historical vector artifact byte locations explicit and deterministic', () => {
    const input = {
      snapshotId: '20000000-0000-4000-8000-000000000010',
      matchId: '20000000-0000-4000-8000-000000000011',
      teamId: '20000000-0000-4000-8000-000000000012',
      revision: 7n,
      setNumber: 1,
      rallyOrdinal: 4,
      clusters: [
        {
          personClusterId: '20000000-0000-4000-8000-000000000013',
          rosterEntryId: '20000000-0000-4000-8000-000000000014',
        },
      ],
      artifacts: [
        {
          artifactId: '20000000-0000-4000-8000-000000000015',
          sha256: 'a'.repeat(64),
          byteLength: 1536n,
        },
      ],
      vectors: [
        {
          vectorId: '20000000-0000-4000-8000-000000000016',
          artifactId: '20000000-0000-4000-8000-000000000015',
          modality: 'DINO',
          modelNamespace: 'dinov2/vits14-reg/v1',
          dimension: 384,
          normalization: 'L2',
          distance: 'COSINE',
          byteOffset: 0n,
          byteLength: 1536n,
          sha256: 'b'.repeat(64),
        },
      ],
      memberships: [
        {
          membershipId: '20000000-0000-4000-8000-000000000017',
          personClusterId: '20000000-0000-4000-8000-000000000013',
          trackletId: '20000000-0000-4000-8000-000000000018',
          vectorIds: ['20000000-0000-4000-8000-000000000016'],
          evidenceRole: 'POSITIVE',
          weight: 1,
          sourceRevision: 7n,
          rosterEntryId: '20000000-0000-4000-8000-000000000014',
        },
      ],
      cannotLinks: [],
    }
    const first = buildReidBankSnapshot(input)
    const second = buildReidBankSnapshot({
      ...input,
      clusters: [...input.clusters].reverse(),
      vectors: [...input.vectors].reverse(),
    })
    expect(second).toEqual(first)
    expect(first.schema_version).toBe('1.1.0')
    expect(first.vectors[0]).toMatchObject({
      artifact_id: '20000000-0000-4000-8000-000000000015',
      byte_offset: '0',
      byte_length: '1536',
      dimension: 384,
      model_namespace: 'dinov2/vits14-reg/v1',
    })
    expect(verifiedSemanticContentSha(first, 'bank snapshot')).toBe(first.content_sha256)
  })
})
