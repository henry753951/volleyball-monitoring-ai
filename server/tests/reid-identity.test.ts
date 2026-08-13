import { describe, expect, it, vi } from 'vitest'
import {
  applyManualReidDecision,
  bindingAppliesAt,
  encodeFloat32Le,
  ingestReidFeatureBank,
  parseReidFeatureBankExtension,
  ReidFeatureBankError,
  resolveReidTeamId,
  selectReidIdentityMatch,
} from '../src/services/reid-identity.js'

const unitPrototype = () => [1, ...Array.from({ length: 511 }, () => 0)]

function resultWithFeatureBank() {
  return {
    tracks: [{ track_id: 7, court_side: 'left', first_frame_index: '10', last_frame_index: '30' }],
    extensions: {
      reid_feature_bank: {
        schema_version: '1.0.0',
        scope: 'clip',
        embedding_model: {
          name: 'sports-osnet',
          checkpoint_sha256: 'a'.repeat(64),
          preprocess_version: 'sports-osnet-v1',
          dimension: 512,
          distance: 'cosine',
        },
        side_feature_banks: [
          { court_side: 'left', features: [{ provisional_gid: 'clip:left:7', track_id: 7, first_frame_index: '10', last_frame_index: '30', sample_count: 4, mean_quality: 0.8, prototype: unitPrototype(), cannot_link_track_ids: [] }] },
          { court_side: 'right', features: [] },
          { court_side: 'unknown', features: [] },
        ],
      },
    },
  } as Record<string, unknown>
}

describe('ReID feature bank validation', () => {
  it('keeps legacy results without the optional extension compatible', () => {
    expect(parseReidFeatureBankExtension({ tracks: [] })).toBeNull()
  })

  it('maps physical submission sides to immutable submission teams', () => {
    const teams = { leftTeamId: 'team-a', rightTeamId: 'team-b' }
    expect(resolveReidTeamId('left', teams)).toBe('team-a')
    expect(resolveReidTeamId('right', teams)).toBe('team-b')
    expect(resolveReidTeamId('unknown', teams)).toBeNull()
  })

  it('accepts cannot-link evidence across opposing physical sides', () => {
    const result = resultWithFeatureBank() as any
    result.tracks.push({ track_id: 8, court_side: 'right', first_frame_index: '10', last_frame_index: '30' })
    result.extensions.reid_feature_bank.side_feature_banks[0].features[0].cannot_link_track_ids = [8]
    result.extensions.reid_feature_bank.side_feature_banks[1].features.push({
      provisional_gid: 'clip:right:8', track_id: 8, first_frame_index: '10', last_frame_index: '30', sample_count: 4,
      mean_quality: 0.8, prototype: [0, 1, ...Array.from({ length: 510 }, () => 0)], cannot_link_track_ids: [7],
    })
    expect(parseReidFeatureBankExtension(result)?.sideFeatureBanks.flatMap(bank => bank.features)).toHaveLength(2)
  })

  it('accepts sample bounds contained within the wider tracker lifetime', () => {
    const result = resultWithFeatureBank() as any
    result.tracks[0].first_frame_index = '0'
    result.tracks[0].last_frame_index = '40'
    const parsed = parseReidFeatureBankExtension(result)
    expect(parsed?.sideFeatureBanks[0]?.features[0]).toMatchObject({ firstFrame: 10n, lastFrame: 30n })
  })

  it('accepts cannot-link tracks that did not yield a prototype', () => {
    const result = resultWithFeatureBank() as any
    result.tracks.push({ track_id: 8, court_side: 'right', first_frame_index: '10', last_frame_index: '30' })
    result.extensions.reid_feature_bank.side_feature_banks[0].features[0].cannot_link_track_ids = [8]
    expect(parseReidFeatureBankExtension(result)?.sideFeatureBanks[0]?.features[0]?.cannotLinkTrackIds).toEqual([8])
  })

  it.each([
    ['wrong dimension', (result: any) => { result.extensions.reid_feature_bank.side_feature_banks[0].features[0].prototype.pop() }],
    ['non-normalized vector', (result: any) => { result.extensions.reid_feature_bank.side_feature_banks[0].features[0].prototype = Array.from({ length: 512 }, () => 0) }],
    ['unknown cannot-link reference', (result: any) => { result.extensions.reid_feature_bank.side_feature_banks[0].features[0].cannot_link_track_ids = [99] }],
    ['wrong physical side reference', (result: any) => { result.tracks[0].court_side = 'right' }],
  ])('rejects %s before persistence', (_label, mutate) => {
    const result = resultWithFeatureBank()
    mutate(result)
    expect(() => parseReidFeatureBankExtension(result)).toThrow(ReidFeatureBankError)
  })

  it('uses exact cosine threshold plus an ambiguity margin', () => {
    const close = [Math.cos(0.01), Math.sin(0.01), ...Array.from({ length: 510 }, () => 0)]
    const orthogonal = [0, 1, ...Array.from({ length: 510 }, () => 0)]
    expect(selectReidIdentityMatch(unitPrototype(), [{ identityId: 'a', prototype: unitPrototype() }, { identityId: 'b', prototype: close }])).toBeNull()
    expect(selectReidIdentityMatch(unitPrototype(), [{ identityId: 'a', prototype: unitPrototype() }, { identityId: 'b', prototype: orthogonal }])).toMatchObject({ identityId: 'a', similarity: 1 })
  })

  it('compares bindings by set and rally order instead of callback time', () => {
    const binding = { effectiveFromSetNumber: 2, effectiveFromRallyOrdinal: 4 }
    expect(bindingAppliesAt(binding, { setNumber: 2, rallyOrdinal: 3 })).toBe(false)
    expect(bindingAppliesAt(binding, { setNumber: 2, rallyOrdinal: 4 })).toBe(true)
    expect(bindingAppliesAt(binding, { setNumber: 3, rallyOrdinal: 1 })).toBe(true)
  })

  it('queries only earlier canonical rallies even if a later callback finished first', async () => {
    const featureBank = parseReidFeatureBankExtension(resultWithFeatureBank())!
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'match-1' }]),
      match: { update: vi.fn().mockResolvedValue({ identityRevision: 2n }) },
      reidIdentity: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({}) },
      reidFeatureObservation: {
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({ id: 'observation-1' }),
      },
      reidPlayerBinding: { findFirst: vi.fn().mockResolvedValue(null) },
      trackIdentityAssignment: { findUnique: vi.fn(), upsert: vi.fn() },
    }

    await ingestReidFeatureBank(tx as never, { analysisRunId: 'run-1', matchId: 'match-1', leftTeamId: 'team-left', rightTeamId: 'team-right', setNumber: 2, rallyOrdinal: 4, featureBank })

    expect(tx.reidFeatureObservation.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        matchId: 'match-1', teamId: 'team-left',
        track: { analysisRun: { supersededAt: null, submission: { activeForRally: { isNot: null } } } },
        OR: [{ setNumber: { lt: 2 } }, { setNumber: 2, rallyOrdinal: { lt: 4 } }],
      }),
      select: { reidIdentityId: true, prototype: true },
    })
  })

  it('uses complete-link scoring across every prototype in one GID', () => {
    const prototypeAt = (similarity: number) => [similarity, Math.sqrt(1 - similarity * similarity), ...Array.from({ length: 510 }, () => 0)]
    expect(selectReidIdentityMatch(unitPrototype(), [
      { identityId: 'gid-a', prototype: unitPrototype() },
      { identityId: 'gid-a', prototype: prototypeAt(0.9) },
      { identityId: 'gid-b', prototype: prototypeAt(0.95) },
    ])).toMatchObject({ identityId: 'gid-b', similarity: 0.95 })
  })

  it('carries the confirmed player to a returning track with a new TID', async () => {
    const featureBank = parseReidFeatureBankExtension(resultWithFeatureBank())!
    const binding = { id: 'binding-1', rosterEntryId: 'roster-9' }
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'match-1' }]),
      match: { update: vi.fn().mockResolvedValue({ identityRevision: 3n }) },
      reidFeatureObservation: {
        findMany: vi.fn()
          .mockResolvedValueOnce([{ reidIdentityId: 'gid-player-9', prototype: encodeFloat32Le(unitPrototype()) }])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([]),
        create: vi.fn().mockResolvedValue({ id: 'returning-observation' }),
      },
      reidPlayerBinding: { findFirst: vi.fn().mockResolvedValue(binding) },
      trackIdentityAssignment: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue({}),
      },
    }

    const result = await ingestReidFeatureBank(tx as never, {
      analysisRunId: 'run-returning',
      matchId: 'match-1',
      leftTeamId: 'team-left',
      rightTeamId: 'team-right',
      setNumber: 2,
      rallyOrdinal: 5,
      featureBank,
    })

    expect(result.propagatedCount).toBe(1)
    expect(tx.trackIdentityAssignment.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        analysisRunId: 'run-returning',
        trackId: 7,
        rosterEntryId: 'roster-9',
        reidIdentityId: 'gid-player-9',
        reidBindingId: 'binding-1',
        source: 'PROPAGATED',
      }),
    }))
  })

  it('reconciles a later rally that was persisted before an earlier callback arrived', async () => {
    const featureBank = parseReidFeatureBankExtension(resultWithFeatureBank())!
    const futurePrototype = encodeFloat32Le(unitPrototype())
    let createdIdentityId = ''
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'match-1' }]),
      match: { update: vi.fn().mockResolvedValue({ identityRevision: 3n }) },
      reidIdentity: {
        findMany: vi.fn().mockResolvedValue([{ label: 'G001' }]),
        create: vi.fn().mockImplementation(({ data }) => { createdIdentityId = data.id; return Promise.resolve({}) }),
      },
      reidFeatureObservation: {
        findMany: vi.fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{
            id: 'future-observation', analysisRunId: 'run-future', trackId: 9, teamId: 'team-left', reidIdentityId: 'gid-future',
            prototype: futurePrototype, cannotLinkTrackIds: [], setNumber: 2, rallyOrdinal: 5, firstFrame: 1n, matchConfidence: null,
          }])
          .mockImplementationOnce(() => Promise.resolve([{ reidIdentityId: createdIdentityId, prototype: futurePrototype }]))
          .mockResolvedValueOnce([]),
        create: vi.fn().mockResolvedValue({ id: 'earlier-observation' }),
        update: vi.fn().mockResolvedValue({}),
      },
      reidPlayerBinding: { findFirst: vi.fn().mockResolvedValue(null) },
      trackIdentityAssignment: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
    }
    await ingestReidFeatureBank(tx as never, { analysisRunId: 'run-earlier', matchId: 'match-1', leftTeamId: 'team-left', rightTeamId: 'team-right', setNumber: 2, rallyOrdinal: 4, featureBank })

    expect(tx.reidIdentity.create.mock.calls[0]![0].data.label).toBe('G002')
    expect(tx.reidFeatureObservation.update).toHaveBeenCalledWith({
      where: { id: 'future-observation' },
      data: expect.objectContaining({ reidIdentityId: createdIdentityId, matchConfidence: 1, identityRevision: 3n }),
    })
  })
})

describe('manual ReID decisions', () => {
  it('creates a team-scoped GID when an unknown-side feature is assigned', async () => {
    const observation = {
      id: 'observation-1', reidIdentityId: null, reidIdentity: null,
      modelNamespace: 'namespace-1', modelName: 'sports-osnet', modelCheckpointSha256: 'a'.repeat(64),
      modelPreprocessVersion: 'sports-osnet-v1', modelDimension: 512, modelDistance: 'cosine',
    }
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'match-1' }]),
      match: { update: vi.fn().mockResolvedValue({ identityRevision: 9n }) },
      reidIdentity: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({}) },
      reidFeatureObservation: {
        findUnique: vi.fn().mockResolvedValue(observation),
        update: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue([]),
      },
      reidPlayerBinding: { create: vi.fn().mockResolvedValue({ id: 'binding-1' }) },
      reidCorrectionEvent: { create: vi.fn().mockResolvedValue({}) },
      trackIdentityAssignment: { findUnique: vi.fn(), upsert: vi.fn() },
    }

    const decision = await applyManualReidDecision(tx as never, { matchId: 'match-1', teamId: 'team-left', analysisRunId: 'run-1', trackId: 7, rosterEntryId: 'roster-1', userId: 'user-1', position: { setNumber: 2, rallyOrdinal: 4 }, mode: 'from_here', replacedTrackIds: [] })

    expect(decision.reidIdentityId).toEqual(expect.any(String))
    expect(tx.reidIdentity.create).toHaveBeenCalledWith({ data: expect.objectContaining({ matchId: 'match-1', teamId: 'team-left', modelNamespace: 'namespace-1' }) })
    expect(tx.reidIdentity.create).toHaveBeenCalledWith({ data: expect.objectContaining({ label: 'G001' }) })
    expect(tx.reidFeatureObservation.update).toHaveBeenCalledWith({ where: { id: 'observation-1' }, data: expect.objectContaining({ teamId: 'team-left', reidIdentityId: decision.reidIdentityId }) })
    expect(tx.reidPlayerBinding.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ effectiveFromSetNumber: 2, effectiveFromRallyOrdinal: 4, sourceObservationId: 'observation-1' }) }))
  })

  it('propagates one confirmed GID to non-overlapping fragments in the same clip', async () => {
    const identity = {
      id: 'gid-existing', matchId: 'match-1', teamId: 'team-left', modelNamespace: 'namespace-1', modelName: 'sports-osnet',
      modelCheckpointSha256: 'a'.repeat(64), modelPreprocessVersion: 'sports-osnet-v1', modelDimension: 512, modelDistance: 'cosine',
    }
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'match-1' }]),
      match: { update: vi.fn().mockResolvedValue({ identityRevision: 10n }) },
      reidIdentity: { create: vi.fn() },
      reidFeatureObservation: {
        findUnique: vi.fn().mockResolvedValue({ id: 'observation-current', reidIdentityId: identity.id, reidIdentity: identity }),
        update: vi.fn(),
        findMany: vi.fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ analysisRunId: 'run-1', trackId: 8, matchConfidence: 0.96 }]),
      },
      reidPlayerBinding: { create: vi.fn().mockResolvedValue({ id: 'binding-1' }) },
      reidCorrectionEvent: { create: vi.fn().mockResolvedValue({}) },
      trackIdentityAssignment: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockResolvedValue({}) },
    }

    await applyManualReidDecision(tx as never, { matchId: 'match-1', teamId: 'team-left', analysisRunId: 'run-1', trackId: 7, rosterEntryId: 'roster-1', userId: 'user-1', position: { setNumber: 2, rallyOrdinal: 4 }, mode: 'from_here', replacedTrackIds: [] })

    expect(tx.reidFeatureObservation.findMany).toHaveBeenCalledWith({
      where: {
        reidIdentityId: identity.id,
        NOT: { analysisRunId: 'run-1', trackId: 7 },
        OR: [{ setNumber: { gt: 2 } }, { setNumber: 2, rallyOrdinal: { gte: 4 } }],
      },
      select: { analysisRunId: true, trackId: true, matchConfidence: true },
    })
    expect(tx.trackIdentityAssignment.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ analysisRunId: 'run-1', trackId: 8, rosterEntryId: 'roster-1', source: 'PROPAGATED' }),
    }))
  })

  it('splits only the selected track prototype and propagates the new GID forward', async () => {
    const sourceIdentity = {
      id: 'gid-old', matchId: 'match-1', teamId: 'team-left', modelNamespace: 'namespace-1', modelName: 'sports-osnet',
      modelCheckpointSha256: 'a'.repeat(64), modelPreprocessVersion: 'sports-osnet-v1', modelDimension: 512, modelDistance: 'cosine',
    }
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'match-1' }]),
      match: { update: vi.fn().mockResolvedValue({ identityRevision: 10n }) },
      reidIdentity: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({}) },
      reidFeatureObservation: {
        findUnique: vi.fn().mockResolvedValue({ id: 'observation-current', prototype: encodeFloat32Le(unitPrototype()), reidIdentityId: 'gid-old', reidIdentity: sourceIdentity }),
        update: vi.fn().mockResolvedValue({}),
        findMany: vi.fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ id: 'observation-later', prototype: encodeFloat32Le(unitPrototype()) }])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ analysisRunId: 'run-later', trackId: 11, matchConfidence: 1 }]),
      },
      reidPlayerBinding: { create: vi.fn().mockResolvedValue({ id: 'binding-new' }) },
      reidCorrectionEvent: { create: vi.fn().mockResolvedValue({}) },
      trackIdentityAssignment: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockResolvedValue({}) },
    }

    const decision = await applyManualReidDecision(tx as never, { matchId: 'match-1', teamId: 'team-left', analysisRunId: 'run-current', trackId: 7, rosterEntryId: 'roster-1', userId: 'user-1', position: { setNumber: 2, rallyOrdinal: 4 }, mode: 'split_identity', replacedTrackIds: [] })

    expect(decision.reidIdentityId).not.toBe('gid-old')
    expect(tx.reidFeatureObservation.update).toHaveBeenCalledTimes(2)
    expect(tx.reidFeatureObservation.update).toHaveBeenCalledWith({ where: { id: 'observation-current' }, data: expect.objectContaining({ reidIdentityId: decision.reidIdentityId }) })
    expect(tx.reidFeatureObservation.update).toHaveBeenCalledWith({ where: { id: 'observation-later' }, data: expect.objectContaining({ reidIdentityId: decision.reidIdentityId, matchConfidence: 1 }) })
    expect(tx.reidFeatureObservation.findMany).toHaveBeenLastCalledWith({
      where: {
        reidIdentityId: decision.reidIdentityId,
        NOT: { analysisRunId: 'run-current', trackId: 7 },
        OR: [{ setNumber: { gt: 2 } }, { setNumber: 2, rallyOrdinal: { gte: 4 } }],
      },
      select: { analysisRunId: true, trackId: true, matchConfidence: true },
    })
    expect(tx.trackIdentityAssignment.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ analysisRunId: 'run-later', reidIdentityId: decision.reidIdentityId, source: 'PROPAGATED' }) }))
  })
})
