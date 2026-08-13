import { createHash, randomUUID } from 'node:crypto'
import { IdentitySource, Prisma, ReidCorrectionKind, TrackCourtSide } from '@volleyball-monitoring/db/client'

export const REID_COSINE_THRESHOLD = 0.9144
export const REID_COSINE_MARGIN = 0.02
const REID_DIMENSION = 512
const REID_PROTOTYPE_BYTES = REID_DIMENSION * Float32Array.BYTES_PER_ELEMENT
const UINT = /^(0|[1-9][0-9]*)$/
const SHA256 = /^[0-9a-f]{64}$/

type TransactionClient = Prisma.TransactionClient
type CourtSide = 'left' | 'right' | 'unknown'

export type ReidIdentityMode = 'from_here' | 'clip_only' | 'split_identity'

export interface ReidEmbeddingModel {
  name: 'sports-osnet'
  checkpointSha256: string
  preprocessVersion: string
  dimension: 512
  distance: 'cosine'
  namespace: string
}

export interface ReidTrackFeature {
  provisionalGid: string
  trackId: number
  firstFrame: bigint
  lastFrame: bigint
  sampleCount: number
  meanQuality: number
  prototype: number[]
  cannotLinkTrackIds: number[]
}

export interface ReidSideFeatureBank {
  courtSide: CourtSide
  features: ReidTrackFeature[]
}

export interface ParsedReidFeatureBank {
  schemaVersion: '1.0.0'
  scope: 'clip'
  embeddingModel: ReidEmbeddingModel
  sideFeatureBanks: ReidSideFeatureBank[]
}

export interface ReidCanonicalPosition {
  setNumber: number
  rallyOrdinal: number
}

export class ReidFeatureBankError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReidFeatureBankError'
  }
}

export class ReidIdentityDecisionError extends Error {
  constructor(readonly code: 'REID_IDENTITY_REQUIRED' | 'REID_OBSERVATION_NOT_FOUND' | 'REID_TEAM_MISMATCH', message: string) {
    super(message)
    this.name = 'ReidIdentityDecisionError'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

function exactRecord(value: unknown, required: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ReidFeatureBankError(`${label} must be an object`)
  if (required.some(key => !(key in value)) || Object.keys(value).some(key => !required.includes(key))) {
    throw new ReidFeatureBankError(`${label} has an invalid shape`)
  }
  return value
}

function integer(value: unknown, label: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ReidFeatureBankError(`${label} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function finiteNumber(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ReidFeatureBankError(`${label} must be a finite number between ${minimum} and ${maximum}`)
  }
  return value
}

function uint64(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !UINT.test(value)) throw new ReidFeatureBankError(`${label} must be a decimal uint64 string`)
  return BigInt(value)
}

function parsePrototype(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.length !== REID_DIMENSION) throw new ReidFeatureBankError(`${label} must contain exactly ${REID_DIMENSION} values`)
  const prototype = value.map((entry, index) => finiteNumber(entry, `${label}[${index}]`, -1, 1))
  const norm = Math.sqrt(prototype.reduce((sum, entry) => sum + entry * entry, 0))
  if (Math.abs(norm - 1) > 0.001) throw new ReidFeatureBankError(`${label} must be L2-normalized`)
  return prototype
}

function modelNamespace(model: Omit<ReidEmbeddingModel, 'namespace'>): string {
  return createHash('sha256').update(JSON.stringify([
    model.name,
    model.checkpointSha256,
    model.preprocessVersion,
    model.dimension,
    model.distance,
  ])).digest('hex')
}

function resultTracks(result: Record<string, unknown>) {
  if (!Array.isArray(result.tracks)) throw new ReidFeatureBankError('analysis tracks are missing')
  const tracks = new Map<number, { courtSide: CourtSide; firstFrame: bigint; lastFrame: bigint }>()
  for (const entry of result.tracks) {
    if (!isRecord(entry)) throw new ReidFeatureBankError('analysis track reference is invalid')
    const trackId = integer(entry.track_id, 'analysis track_id', 0, 65_534)
    const courtSide = entry.court_side
    if (courtSide !== 'left' && courtSide !== 'right' && courtSide !== 'unknown') throw new ReidFeatureBankError('analysis court_side is invalid')
    const firstFrame = uint64(entry.first_frame_index, 'analysis first_frame_index')
    const lastFrame = uint64(entry.last_frame_index, 'analysis last_frame_index')
    tracks.set(trackId, { courtSide, firstFrame, lastFrame })
  }
  return tracks
}

export function parseReidFeatureBankExtension(result: Record<string, unknown>): ParsedReidFeatureBank | null {
  if (!isRecord(result.extensions) || !('reid_feature_bank' in result.extensions)) return null
  const payload = exactRecord(result.extensions.reid_feature_bank, ['schema_version', 'scope', 'embedding_model', 'side_feature_banks'], 'reid_feature_bank')
  if (payload.schema_version !== '1.0.0' || payload.scope !== 'clip') throw new ReidFeatureBankError('reid_feature_bank version or scope is unsupported')

  const rawModel = exactRecord(payload.embedding_model, ['name', 'checkpoint_sha256', 'preprocess_version', 'dimension', 'distance'], 'embedding_model')
  if (rawModel.name !== 'sports-osnet' || rawModel.dimension !== REID_DIMENSION || rawModel.distance !== 'cosine') {
    throw new ReidFeatureBankError('embedding_model is not the supported normalized Sports OSNet 512-D cosine namespace')
  }
  if (typeof rawModel.checkpoint_sha256 !== 'string' || !SHA256.test(rawModel.checkpoint_sha256.toLowerCase())) throw new ReidFeatureBankError('embedding_model checkpoint_sha256 is invalid')
  if (typeof rawModel.preprocess_version !== 'string' || rawModel.preprocess_version.length < 1 || rawModel.preprocess_version.length > 128) throw new ReidFeatureBankError('embedding_model preprocess_version is invalid')
  const modelWithoutNamespace = {
    name: 'sports-osnet' as const,
    checkpointSha256: rawModel.checkpoint_sha256.toLowerCase(),
    preprocessVersion: rawModel.preprocess_version,
    dimension: REID_DIMENSION as 512,
    distance: 'cosine' as const,
  }
  const embeddingModel: ReidEmbeddingModel = { ...modelWithoutNamespace, namespace: modelNamespace(modelWithoutNamespace) }

  if (!Array.isArray(payload.side_feature_banks) || payload.side_feature_banks.length !== 3) throw new ReidFeatureBankError('side_feature_banks must contain left, right and unknown exactly once')
  const tracks = resultTracks(result)
  const seenSides = new Set<CourtSide>()
  const seenTracks = new Set<number>()
  const sideFeatureBanks: ReidSideFeatureBank[] = payload.side_feature_banks.map((entry, bankIndex) => {
    const bank = exactRecord(entry, ['court_side', 'features'], `side_feature_banks[${bankIndex}]`)
    const courtSide = bank.court_side
    if (courtSide !== 'left' && courtSide !== 'right' && courtSide !== 'unknown') throw new ReidFeatureBankError(`side_feature_banks[${bankIndex}].court_side is invalid`)
    if (seenSides.has(courtSide)) throw new ReidFeatureBankError(`side_feature_banks contains duplicate ${courtSide}`)
    seenSides.add(courtSide)
    if (!Array.isArray(bank.features)) throw new ReidFeatureBankError(`side_feature_banks[${bankIndex}].features must be an array`)
    const features = bank.features.map((entry, featureIndex) => {
      const label = `side_feature_banks[${bankIndex}].features[${featureIndex}]`
      const feature = exactRecord(entry, ['provisional_gid', 'track_id', 'first_frame_index', 'last_frame_index', 'sample_count', 'mean_quality', 'prototype', 'cannot_link_track_ids'], label)
      const trackId = integer(feature.track_id, `${label}.track_id`, 0, 65_534)
      const track = tracks.get(trackId)
      if (!track || track.courtSide !== courtSide) throw new ReidFeatureBankError(`${label}.track_id does not reference an analysis track on ${courtSide}`)
      if (seenTracks.has(trackId)) throw new ReidFeatureBankError(`track ${trackId} appears in more than one feature bank`)
      seenTracks.add(trackId)
      if (feature.provisional_gid !== `clip:${courtSide}:${trackId}`) throw new ReidFeatureBankError(`${label}.provisional_gid does not match its side and track`)
      const firstFrame = uint64(feature.first_frame_index, `${label}.first_frame_index`)
      const lastFrame = uint64(feature.last_frame_index, `${label}.last_frame_index`)
      if (firstFrame < track.firstFrame || lastFrame > track.lastFrame || lastFrame < firstFrame) throw new ReidFeatureBankError(`${label} frame range is not contained by the analysis track`)
      const sampleCount = integer(feature.sample_count, `${label}.sample_count`, 1)
      const meanQuality = finiteNumber(feature.mean_quality, `${label}.mean_quality`, 0, 1)
      const prototype = parsePrototype(feature.prototype, `${label}.prototype`)
      if (!Array.isArray(feature.cannot_link_track_ids)) throw new ReidFeatureBankError(`${label}.cannot_link_track_ids must be an array`)
      const cannotLinkTrackIds = feature.cannot_link_track_ids.map((value, index) => integer(value, `${label}.cannot_link_track_ids[${index}]`, 0, 65_534))
      if (new Set(cannotLinkTrackIds).size !== cannotLinkTrackIds.length || cannotLinkTrackIds.includes(trackId)) throw new ReidFeatureBankError(`${label}.cannot_link_track_ids contains a duplicate or self reference`)
      return { provisionalGid: feature.provisional_gid as string, trackId, firstFrame, lastFrame, sampleCount, meanQuality, prototype, cannotLinkTrackIds }
    })
    return { courtSide, features }
  })
  if (seenSides.size !== 3 || !seenSides.has('left') || !seenSides.has('right') || !seenSides.has('unknown')) throw new ReidFeatureBankError('side_feature_banks must contain left, right and unknown exactly once')

  for (const bank of sideFeatureBanks) for (const feature of bank.features) for (const linkedTrackId of feature.cannotLinkTrackIds) {
    if (!tracks.has(linkedTrackId)) throw new ReidFeatureBankError(`track ${feature.trackId} cannot-link reference ${linkedTrackId} is not an analysis track`)
  }

  return { schemaVersion: '1.0.0', scope: 'clip', embeddingModel, sideFeatureBanks }
}

export function encodeFloat32Le(prototype: readonly number[]): Uint8Array<ArrayBuffer> {
  if (prototype.length !== REID_DIMENSION) throw new RangeError(`ReID prototype must contain ${REID_DIMENSION} values`)
  const result = new Uint8Array(REID_PROTOTYPE_BYTES)
  const view = new DataView(result.buffer)
  prototype.forEach((value, index) => view.setFloat32(index * Float32Array.BYTES_PER_ELEMENT, value, true))
  return result
}

export function decodeFloat32Le(prototype: Uint8Array): number[] {
  if (prototype.byteLength !== REID_PROTOTYPE_BYTES) throw new RangeError(`Persisted ReID prototype must contain ${REID_PROTOTYPE_BYTES} bytes`)
  const bytes = Buffer.from(prototype)
  return Array.from({ length: REID_DIMENSION }, (_, index) => bytes.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT))
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length !== REID_DIMENSION) throw new RangeError('ReID cosine inputs must both be 512-D')
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < REID_DIMENSION; index += 1) {
    const leftValue = left[index]!
    const rightValue = right[index]!
    dot += leftValue * rightValue
    leftNorm += leftValue * leftValue
    rightNorm += rightValue * rightValue
  }
  if (leftNorm === 0 || rightNorm === 0) throw new RangeError('ReID cosine input cannot be zero')
  return dot / Math.sqrt(leftNorm * rightNorm)
}

export interface ReidIdentityCandidate {
  identityId: string
  prototype: readonly number[]
}

export function selectReidIdentityMatch(
  prototype: readonly number[],
  candidates: readonly ReidIdentityCandidate[],
  forbiddenIdentityIds: ReadonlySet<string> = new Set(),
): { identityId: string; similarity: number } | null {
  const bestByIdentity = new Map<string, number>()
  for (const candidate of candidates) {
    if (forbiddenIdentityIds.has(candidate.identityId)) continue
    const similarity = cosineSimilarity(prototype, candidate.prototype)
    bestByIdentity.set(candidate.identityId, Math.max(similarity, bestByIdentity.get(candidate.identityId) ?? -1))
  }
  const ranked = [...bestByIdentity].map(([identityId, similarity]) => ({ identityId, similarity }))
    .sort((left, right) => right.similarity - left.similarity || left.identityId.localeCompare(right.identityId))
  const best = ranked[0]
  if (!best || best.similarity < REID_COSINE_THRESHOLD) return null
  const runnerUp = ranked[1]
  if (runnerUp && best.similarity - runnerUp.similarity < REID_COSINE_MARGIN) return null
  return best
}

export function compareCanonicalPosition(left: ReidCanonicalPosition, right: ReidCanonicalPosition): number {
  return left.setNumber - right.setNumber || left.rallyOrdinal - right.rallyOrdinal
}

export function bindingAppliesAt(binding: { effectiveFromSetNumber: number; effectiveFromRallyOrdinal: number }, position: ReidCanonicalPosition): boolean {
  return compareCanonicalPosition({ setNumber: binding.effectiveFromSetNumber, rallyOrdinal: binding.effectiveFromRallyOrdinal }, position) <= 0
}

export function resolveReidTeamId(side: CourtSide, teams: { leftTeamId: string; rightTeamId: string }): string | null {
  return side === 'left' ? teams.leftTeamId : side === 'right' ? teams.rightTeamId : null
}

function canonicalAtOrAfter(position: ReidCanonicalPosition) {
  return {
    OR: [
      { setNumber: { gt: position.setNumber } },
      { setNumber: position.setNumber, rallyOrdinal: { gte: position.rallyOrdinal } },
    ],
  }
}

function canonicalBefore(position: ReidCanonicalPosition) {
  return {
    OR: [
      { setNumber: { lt: position.setNumber } },
      { setNumber: position.setNumber, rallyOrdinal: { lt: position.rallyOrdinal } },
    ],
  }
}

async function latestBinding(tx: TransactionClient, reidIdentityId: string, position: ReidCanonicalPosition) {
  return tx.reidPlayerBinding.findFirst({
    where: {
      reidIdentityId,
      OR: [
        { effectiveFromSetNumber: { lt: position.setNumber } },
        { effectiveFromSetNumber: position.setNumber, effectiveFromRallyOrdinal: { lte: position.rallyOrdinal } },
      ],
    },
    orderBy: [{ effectiveFromSetNumber: 'desc' }, { effectiveFromRallyOrdinal: 'desc' }, { identityRevision: 'desc' }],
  })
}

function identityData(input: { matchId: string; teamId: string; model: ReidEmbeddingModel; revision: bigint }) {
  const id = randomUUID()
  return {
    id,
    data: {
      id,
      matchId: input.matchId,
      teamId: input.teamId,
      modelNamespace: input.model.namespace,
      modelName: input.model.name,
      modelCheckpointSha256: input.model.checkpointSha256,
      modelPreprocessVersion: input.model.preprocessVersion,
      modelDimension: input.model.dimension,
      modelDistance: input.model.distance,
      label: `GID-${id.slice(0, 8).toUpperCase()}`,
      createdRevision: input.revision,
    },
  }
}

export async function ingestReidFeatureBank(
  tx: TransactionClient,
  input: {
    analysisRunId: string
    matchId: string
    leftTeamId: string
    rightTeamId: string
    setNumber: number
    rallyOrdinal: number
    featureBank: ParsedReidFeatureBank | null
  },
) {
  const features = input.featureBank?.sideFeatureBanks.flatMap(bank => bank.features.map(feature => ({ bank, feature }))) ?? []
  if (!input.featureBank || features.length === 0) return { identityRevision: null, observationCount: 0, propagatedCount: 0 }
  await tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${input.matchId}::uuid FOR UPDATE`
  const match = await tx.match.update({ where: { id: input.matchId }, data: { identityRevision: { increment: 1 } }, select: { identityRevision: true } })
  const revision = match.identityRevision
  const position = { setNumber: input.setNumber, rallyOrdinal: input.rallyOrdinal }
  const model = input.featureBank.embeddingModel
  const historyByTeam = new Map<string, ReidIdentityCandidate[]>()
  const assignedInClip = new Map<number, string>()
  const cannotLinks = new Map<number, Set<number>>()
  for (const { feature } of features) {
    const links = cannotLinks.get(feature.trackId) ?? new Set<number>()
    for (const linkedTrackId of feature.cannotLinkTrackIds) {
      links.add(linkedTrackId)
      const reverse = cannotLinks.get(linkedTrackId) ?? new Set<number>()
      reverse.add(feature.trackId)
      cannotLinks.set(linkedTrackId, reverse)
    }
    cannotLinks.set(feature.trackId, links)
  }

  let propagatedCount = 0
  const ordered = [...features].sort((left, right) => left.feature.firstFrame < right.feature.firstFrame ? -1 : left.feature.firstFrame > right.feature.firstFrame ? 1 : left.feature.trackId - right.feature.trackId)
  for (const { bank, feature } of ordered) {
    const teamId = resolveReidTeamId(bank.courtSide, { leftTeamId: input.leftTeamId, rightTeamId: input.rightTeamId })
    let reidIdentityId: string | null = null
    let matchConfidence: number | null = null
    if (teamId) {
      let history = historyByTeam.get(teamId)
      if (!history) {
        const persisted = await tx.reidFeatureObservation.findMany({
          where: {
            analysisRunId: { not: input.analysisRunId },
            matchId: input.matchId,
            teamId,
            modelNamespace: model.namespace,
            reidIdentityId: { not: null },
            ...canonicalBefore(position),
          },
          select: { reidIdentityId: true, prototype: true },
        })
        history = persisted.flatMap(item => item.reidIdentityId ? [{ identityId: item.reidIdentityId, prototype: decodeFloat32Le(item.prototype) }] : [])
        historyByTeam.set(teamId, history)
      }
      const forbidden = new Set<string>()
      for (const linkedTrackId of cannotLinks.get(feature.trackId) ?? []) {
        const identityId = assignedInClip.get(linkedTrackId)
        if (identityId) forbidden.add(identityId)
      }
      const matched = selectReidIdentityMatch(feature.prototype, history, forbidden)
      if (matched) {
        reidIdentityId = matched.identityId
        matchConfidence = matched.similarity
      } else {
        const created = identityData({ matchId: input.matchId, teamId, model, revision })
        await tx.reidIdentity.create({ data: created.data })
        reidIdentityId = created.id
      }
      assignedInClip.set(feature.trackId, reidIdentityId)
      history.push({ identityId: reidIdentityId, prototype: feature.prototype })
    }

    const observation = await tx.reidFeatureObservation.create({
      data: {
        analysisRunId: input.analysisRunId,
        trackId: feature.trackId,
        matchId: input.matchId,
        teamId,
        reidIdentityId,
        modelNamespace: model.namespace,
        modelName: model.name,
        modelCheckpointSha256: model.checkpointSha256,
        modelPreprocessVersion: model.preprocessVersion,
        modelDimension: model.dimension,
        modelDistance: model.distance,
        courtSide: bank.courtSide.toUpperCase() as TrackCourtSide,
        provisionalGid: feature.provisionalGid,
        firstFrame: feature.firstFrame,
        lastFrame: feature.lastFrame,
        sampleCount: feature.sampleCount,
        meanQuality: feature.meanQuality,
        prototype: encodeFloat32Le(feature.prototype),
        cannotLinkTrackIds: feature.cannotLinkTrackIds,
        setNumber: position.setNumber,
        rallyOrdinal: position.rallyOrdinal,
        matchConfidence,
        identityRevision: revision,
      },
    })
    if (!reidIdentityId) continue
    const binding = await latestBinding(tx, reidIdentityId, position)
    if (!binding?.rosterEntryId) continue
    const existing = await tx.trackIdentityAssignment.findUnique({ where: { analysisRunId_trackId: { analysisRunId: input.analysisRunId, trackId: feature.trackId } }, select: { source: true } })
    if (existing?.source === IdentitySource.MANUAL) continue
    await tx.trackIdentityAssignment.upsert({
      where: { analysisRunId_trackId: { analysisRunId: input.analysisRunId, trackId: feature.trackId } },
      create: {
        analysisRunId: input.analysisRunId,
        trackId: feature.trackId,
        rosterEntryId: binding.rosterEntryId,
        source: IdentitySource.PROPAGATED,
        confidence: matchConfidence,
        reidIdentityId,
        reidBindingId: binding.id,
        identityRevision: revision,
      },
      update: {
        rosterEntryId: binding.rosterEntryId,
        source: IdentitySource.PROPAGATED,
        assignedByUserId: null,
        confidence: matchConfidence,
        reidIdentityId,
        reidBindingId: binding.id,
        identityRevision: revision,
      },
    })
    propagatedCount += 1
    void observation
  }
  return { identityRevision: revision, observationCount: features.length, propagatedCount }
}

export function parseReidIdentityMode(value: unknown): ReidIdentityMode {
  if (value === undefined || value === null || value === '') return 'from_here'
  if (value === 'from_here' || value === 'clip_only' || value === 'split_identity') return value
  throw new TypeError('identityMode must be from_here, clip_only or split_identity')
}

export async function applyManualReidDecision(
  tx: TransactionClient,
  input: {
    matchId: string
    teamId: string
    analysisRunId: string
    trackId: number
    rosterEntryId: string
    userId: string
    position: ReidCanonicalPosition
    mode: ReidIdentityMode
    replacedTrackIds: number[]
  },
) {
  const observation = await tx.reidFeatureObservation.findUnique({
    where: { analysisRunId_trackId: { analysisRunId: input.analysisRunId, trackId: input.trackId } },
    include: { reidIdentity: true },
  })
  if (input.mode === 'split_identity' && !observation?.reidIdentity) {
    throw new ReidIdentityDecisionError('REID_IDENTITY_REQUIRED', 'This track has no ReID identity to split')
  }
  if (observation?.reidIdentity && observation.reidIdentity.teamId !== input.teamId) {
    throw new ReidIdentityDecisionError('REID_TEAM_MISMATCH', 'The ReID identity belongs to a different team')
  }
  await tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${input.matchId}::uuid FOR UPDATE`
  const match = await tx.match.update({ where: { id: input.matchId }, data: { identityRevision: { increment: 1 } }, select: { identityRevision: true } })
  const revision = match.identityRevision
  const sourceIdentityId = observation?.reidIdentityId ?? null
  let targetIdentityId = sourceIdentityId
  let reassociatedObservationIds: string[] = []
  if (observation && !observation.reidIdentity) {
    const id = randomUUID()
    await tx.reidIdentity.create({ data: {
      id,
      matchId: input.matchId,
      teamId: input.teamId,
      modelNamespace: observation.modelNamespace,
      modelName: observation.modelName,
      modelCheckpointSha256: observation.modelCheckpointSha256,
      modelPreprocessVersion: observation.modelPreprocessVersion,
      modelDimension: observation.modelDimension,
      modelDistance: observation.modelDistance,
      label: `GID-${id.slice(0, 8).toUpperCase()}`,
      createdRevision: revision,
    } })
    targetIdentityId = id
    await tx.reidFeatureObservation.update({ where: { id: observation.id }, data: { teamId: input.teamId, reidIdentityId: id, identityRevision: revision, matchConfidence: null } })
  } else if (input.mode === 'split_identity' && observation?.reidIdentity) {
    const source = observation.reidIdentity
    const id = randomUUID()
    await tx.reidIdentity.create({ data: {
      id,
      matchId: source.matchId,
      teamId: source.teamId,
      modelNamespace: source.modelNamespace,
      modelName: source.modelName,
      modelCheckpointSha256: source.modelCheckpointSha256,
      modelPreprocessVersion: source.modelPreprocessVersion,
      modelDimension: source.modelDimension,
      modelDistance: source.modelDistance,
      label: `GID-${id.slice(0, 8).toUpperCase()}`,
      createdRevision: revision,
    } })
    targetIdentityId = id
    await tx.reidFeatureObservation.update({ where: { id: observation.id }, data: { reidIdentityId: id, identityRevision: revision, matchConfidence: null } })

    const [sourceReferences, laterSourceObservations] = await Promise.all([
      tx.reidFeatureObservation.findMany({
        where: { reidIdentityId: source.id, ...canonicalBefore(input.position) },
        select: { prototype: true },
      }),
      tx.reidFeatureObservation.findMany({
        where: { reidIdentityId: source.id, analysisRunId: { not: input.analysisRunId }, ...canonicalAtOrAfter(input.position) },
        select: { id: true, prototype: true },
      }),
    ])
    const currentPrototype = decodeFloat32Le(observation.prototype)
    const referenceCandidates: ReidIdentityCandidate[] = sourceReferences.map(item => ({ identityId: source.id, prototype: decodeFloat32Le(item.prototype) }))
    for (const candidate of laterSourceObservations) {
      const match = selectReidIdentityMatch(decodeFloat32Le(candidate.prototype), [
        { identityId: id, prototype: currentPrototype },
        ...referenceCandidates,
      ])
      if (match?.identityId !== id) continue
      await tx.reidFeatureObservation.update({ where: { id: candidate.id }, data: { reidIdentityId: id, identityRevision: revision, matchConfidence: match.similarity } })
      reassociatedObservationIds.push(candidate.id)
    }
  }

  let binding: { id: string } | null = null
  if (targetIdentityId && input.mode !== 'clip_only') {
    binding = await tx.reidPlayerBinding.create({ data: {
      reidIdentityId: targetIdentityId,
      rosterEntryId: input.rosterEntryId,
      sourceObservationId: observation?.id ?? null,
      effectiveFromSetNumber: input.position.setNumber,
      effectiveFromRallyOrdinal: input.position.rallyOrdinal,
      source: IdentitySource.MANUAL,
      identityRevision: revision,
      assignedByUserId: input.userId,
    }, select: { id: true } })
  }

  await tx.reidCorrectionEvent.create({ data: {
    matchId: input.matchId,
    teamId: input.teamId,
    analysisRunId: input.analysisRunId,
    trackId: input.trackId,
    sourceIdentityId,
    targetIdentityId,
    rosterEntryId: input.rosterEntryId,
    kind: input.mode === 'from_here' ? ReidCorrectionKind.FROM_HERE : input.mode === 'clip_only' ? ReidCorrectionKind.CLIP_ONLY : ReidCorrectionKind.SPLIT_IDENTITY,
    identityRevision: revision,
    createdByUserId: input.userId,
    details: json({ replaced_track_ids: input.replacedTrackIds, reassociated_observation_ids: reassociatedObservationIds }),
  } })

  if (binding && targetIdentityId) {
    const later = await tx.reidFeatureObservation.findMany({
      where: {
        reidIdentityId: targetIdentityId,
        NOT: { analysisRunId: input.analysisRunId, trackId: input.trackId },
        ...canonicalAtOrAfter(input.position),
      },
      select: { analysisRunId: true, trackId: true, matchConfidence: true },
    })
    for (const item of later) {
      const existing = await tx.trackIdentityAssignment.findUnique({ where: { analysisRunId_trackId: { analysisRunId: item.analysisRunId, trackId: item.trackId } }, select: { source: true } })
      if (existing?.source === IdentitySource.MANUAL) continue
      await tx.trackIdentityAssignment.upsert({
        where: { analysisRunId_trackId: { analysisRunId: item.analysisRunId, trackId: item.trackId } },
        create: { analysisRunId: item.analysisRunId, trackId: item.trackId, rosterEntryId: input.rosterEntryId, source: IdentitySource.PROPAGATED, confidence: item.matchConfidence, reidIdentityId: targetIdentityId, reidBindingId: binding.id, identityRevision: revision },
        update: { rosterEntryId: input.rosterEntryId, source: IdentitySource.PROPAGATED, assignedByUserId: null, confidence: item.matchConfidence, reidIdentityId: targetIdentityId, reidBindingId: binding.id, identityRevision: revision },
      })
    }
  }

  return { bindingId: binding?.id ?? null, reidIdentityId: targetIdentityId, identityRevision: revision }
}
