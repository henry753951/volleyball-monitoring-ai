import { createHash, randomUUID } from 'node:crypto'
import { IdentitySource, Prisma, TrackCourtSide } from '@volleyball-monitoring/db/client'

type TransactionClient = Prisma.TransactionClient
type CourtSide = 'left' | 'right' | 'unknown'
type DescriptorName = 'dino' | 'osnet' | 'kpr' | 'kpr_prompt'
type KernelName = 'linear' | 'cosine2' | 'rbf'

const UINT = /^(0|[1-9][0-9]*)$/
const SLOT_COUNT = 6
const FIXED_ROSTER_IDENTITY_NAMESPACE = 'fixed-six-per-team-v2'
const DESCRIPTOR_DIMENSIONS: Record<DescriptorName, number> = {
  dino: 384,
  osnet: 512,
  kpr: 4096,
  kpr_prompt: 4096,
}
const MODALITIES = Object.keys(DESCRIPTOR_DIMENSIONS) as DescriptorName[]
const REGULARIZATIONS = [0.001, 0.01, 0.1, 1, 10] as const
const KERNELS: KernelName[] = ['linear', 'cosine2', 'rbf']

export interface FixedRosterTracklet {
  canonicalTrackId: number
  trackIds: number[]
  courtSide: CourtSide
  medianCourtPos: [number, number] | null
  firstFrame: bigint
  lastFrame: bigint
  sampleCount: number
  meanQuality: number
  promptCoverage: number
  descriptors: Record<DescriptorName, number[]> | null
  cannotLinkCanonicalTrackIds: number[]
}

export interface ParsedFixedRosterReid {
  schemaVersion: '2.0.0'
  scope: 'clip'
  identityContract: 'fixed-six-per-team'
  slotsPerTeam: 6
  descriptorRecipe: Record<string, unknown>
  modelNamespace: string
  tracklets: FixedRosterTracklet[]
}

export interface HistoricalRow {
  clipId: string
  label: string
  descriptors: Record<DescriptorName, number[]>
}

export interface NestedCandidate {
  modalities: DescriptorName[]
  regularization: number
  kernel: KernelName
}

export class FixedRosterReidError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FixedRosterReidError'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function exactRecord(value: unknown, keys: readonly string[], label: string) {
  if (!isRecord(value)) throw new FixedRosterReidError(`${label} must be an object`)
  if (keys.some(key => !(key in value)) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new FixedRosterReidError(`${label} has an invalid shape`)
  }
  return value
}

function integer(value: unknown, label: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new FixedRosterReidError(`${label} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function finite(value: unknown, label: string, minimum: number, maximum: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new FixedRosterReidError(`${label} must be between ${minimum} and ${maximum}`)
  }
  return value
}

function uint64(value: unknown, label: string) {
  if (typeof value !== 'string' || !UINT.test(value)) {
    throw new FixedRosterReidError(`${label} must be a decimal uint64 string`)
  }
  return BigInt(value)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!isRecord(value)) return JSON.stringify(value)
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

function parseDescriptor(value: unknown, name: DescriptorName, label: string) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new FixedRosterReidError(`${label}.${name} must be base64 Float32LE`)
  }
  const bytes = Buffer.from(value, 'base64')
  const dimension = DESCRIPTOR_DIMENSIONS[name]
  if (bytes.byteLength !== dimension * Float32Array.BYTES_PER_ELEMENT) {
    throw new FixedRosterReidError(`${label}.${name} must contain ${dimension} Float32LE values`)
  }
  const result = Array.from({ length: dimension }, (_, index) => bytes.readFloatLE(index * 4))
  if (result.some(entry => !Number.isFinite(entry))) {
    throw new FixedRosterReidError(`${label}.${name} contains a non-finite value`)
  }
  const norm = Math.sqrt(result.reduce((sum, entry) => sum + entry * entry, 0))
  if (Math.abs(norm - 1) > 0.001) {
    throw new FixedRosterReidError(`${label}.${name} must be L2-normalized`)
  }
  return result
}

function resultTracks(result: Record<string, unknown>) {
  if (!Array.isArray(result.tracks)) throw new FixedRosterReidError('analysis tracks are missing')
  const tracks = new Map<number, { courtSide: CourtSide; firstFrame: bigint; lastFrame: bigint }>()
  for (const entry of result.tracks) {
    if (!isRecord(entry)) throw new FixedRosterReidError('analysis track reference is invalid')
    const trackId = integer(entry.track_id, 'analysis track_id', 0, 65_534)
    const courtSide = entry.court_side
    if (courtSide !== 'left' && courtSide !== 'right' && courtSide !== 'unknown') {
      throw new FixedRosterReidError('analysis court_side is invalid')
    }
    tracks.set(trackId, {
      courtSide,
      firstFrame: uint64(entry.first_frame_index, 'analysis first_frame_index'),
      lastFrame: uint64(entry.last_frame_index, 'analysis last_frame_index'),
    })
  }
  return tracks
}

export function parseFixedRosterReidExtension(result: Record<string, unknown>): ParsedFixedRosterReid | null {
  if (!isRecord(result.extensions) || !('fixed_roster_reid' in result.extensions)) return null
  const payload = exactRecord(
    result.extensions.fixed_roster_reid,
    ['schema_version', 'scope', 'identity_contract', 'slots_per_team', 'descriptor_recipe', 'tracklets'],
    'fixed_roster_reid',
  )
  if (payload.schema_version !== '2.0.0' || payload.scope !== 'clip') {
    throw new FixedRosterReidError('fixed_roster_reid version or scope is unsupported')
  }
  if (payload.identity_contract !== 'fixed-six-per-team' || payload.slots_per_team !== SLOT_COUNT) {
    throw new FixedRosterReidError('fixed_roster_reid must use exactly six slots per team')
  }
  if (!isRecord(payload.descriptor_recipe)
    || payload.descriptor_recipe.name !== 'nested-part-adaptation'
    || payload.descriptor_recipe.version !== '1.0.0'
    || payload.descriptor_recipe.selection_protocol !== 'past-only-nested-leave-one-clip-out') {
    throw new FixedRosterReidError('descriptor_recipe is not Nested Part Adaptation v1')
  }
  if (!Array.isArray(payload.tracklets)) throw new FixedRosterReidError('tracklets must be an array')

  const tracks = resultTracks(result)
  const seenTrackIds = new Set<number>()
  const seenCanonicalIds = new Set<number>()
  const tracklets = payload.tracklets.map((entry, index): FixedRosterTracklet => {
    const label = `tracklets[${index}]`
    const tracklet = exactRecord(entry, [
      'canonical_track_id', 'track_ids', 'court_side', 'median_court_pos',
      'first_frame_index', 'last_frame_index', 'sample_count', 'mean_quality',
      'prompt_coverage', 'descriptors', 'cannot_link_canonical_track_ids',
    ], label)
    const canonicalTrackId = integer(tracklet.canonical_track_id, `${label}.canonical_track_id`, 0, 65_534)
    if (seenCanonicalIds.has(canonicalTrackId)) throw new FixedRosterReidError(`${label} duplicates a canonical track`)
    seenCanonicalIds.add(canonicalTrackId)
    if (!Array.isArray(tracklet.track_ids) || tracklet.track_ids.length === 0) {
      throw new FixedRosterReidError(`${label}.track_ids must be non-empty`)
    }
    const trackIds = tracklet.track_ids.map((value, aliasIndex) =>
      integer(value, `${label}.track_ids[${aliasIndex}]`, 0, 65_534))
    if (!trackIds.includes(canonicalTrackId) || new Set(trackIds).size !== trackIds.length) {
      throw new FixedRosterReidError(`${label}.track_ids must uniquely contain its canonical track`)
    }
    const courtSide = tracklet.court_side
    if (courtSide !== 'left' && courtSide !== 'right' && courtSide !== 'unknown') {
      throw new FixedRosterReidError(`${label}.court_side is invalid`)
    }
    for (const trackId of trackIds) {
      const track = tracks.get(trackId)
      if (!track || track.courtSide !== courtSide || seenTrackIds.has(trackId)) {
        throw new FixedRosterReidError(`${label} has an invalid or repeated analysis track reference`)
      }
      seenTrackIds.add(trackId)
    }
    const firstFrame = uint64(tracklet.first_frame_index, `${label}.first_frame_index`)
    const lastFrame = uint64(tracklet.last_frame_index, `${label}.last_frame_index`)
    const aliasTracks = trackIds.map(trackId => tracks.get(trackId)!)
    const earliestAliasFrame = aliasTracks.reduce((minimum, track) =>
      track.firstFrame < minimum ? track.firstFrame : minimum, aliasTracks[0]!.firstFrame)
    const latestAliasFrame = aliasTracks.reduce((maximum, track) =>
      track.lastFrame > maximum ? track.lastFrame : maximum, aliasTracks[0]!.lastFrame)
    if (lastFrame < firstFrame || firstFrame < earliestAliasFrame || lastFrame > latestAliasFrame) {
      throw new FixedRosterReidError(`${label} frame range is outside its alias group`)
    }
    let medianCourtPos: [number, number] | null = null
    if (tracklet.median_court_pos !== null) {
      if (!Array.isArray(tracklet.median_court_pos) || tracklet.median_court_pos.length !== 2) {
        throw new FixedRosterReidError(`${label}.median_court_pos must be null or [x,y]`)
      }
      medianCourtPos = [
        finite(tracklet.median_court_pos[0], `${label}.median_court_pos[0]`, -100, 100),
        finite(tracklet.median_court_pos[1], `${label}.median_court_pos[1]`, -100, 100),
      ]
    }
    let descriptors: Record<DescriptorName, number[]> | null = null
    if (tracklet.descriptors !== null) {
      const raw = exactRecord(tracklet.descriptors, MODALITIES, `${label}.descriptors`)
      descriptors = Object.fromEntries(MODALITIES.map(name => [name, parseDescriptor(raw[name], name, `${label}.descriptors`)])) as Record<DescriptorName, number[]>
    }
    if (!Array.isArray(tracklet.cannot_link_canonical_track_ids)) {
      throw new FixedRosterReidError(`${label}.cannot_link_canonical_track_ids must be an array`)
    }
    const cannotLinkCanonicalTrackIds = tracklet.cannot_link_canonical_track_ids.map((value, linkIndex) =>
      integer(value, `${label}.cannot_link_canonical_track_ids[${linkIndex}]`, 0, 65_534))
    if (cannotLinkCanonicalTrackIds.includes(canonicalTrackId)
      || new Set(cannotLinkCanonicalTrackIds).size !== cannotLinkCanonicalTrackIds.length) {
      throw new FixedRosterReidError(`${label} contains a duplicate or self cannot-link`)
    }
    return {
      canonicalTrackId,
      trackIds,
      courtSide,
      medianCourtPos,
      firstFrame,
      lastFrame,
      sampleCount: integer(tracklet.sample_count, `${label}.sample_count`, 1),
      meanQuality: finite(tracklet.mean_quality, `${label}.mean_quality`, 0, 1),
      promptCoverage: finite(tracklet.prompt_coverage, `${label}.prompt_coverage`, 0, 1),
      descriptors,
      cannotLinkCanonicalTrackIds,
    }
  })
  for (const tracklet of tracklets) {
    for (const linked of tracklet.cannotLinkCanonicalTrackIds) {
      const other = tracklets.find(candidate => candidate.canonicalTrackId === linked)
      if (!other || !other.cannotLinkCanonicalTrackIds.includes(tracklet.canonicalTrackId)) {
        throw new FixedRosterReidError(`cannot-link ${tracklet.canonicalTrackId}<->${linked} must be symmetric`)
      }
    }
  }
  const descriptorRecipe = payload.descriptor_recipe
  return {
    schemaVersion: '2.0.0',
    scope: 'clip',
    identityContract: 'fixed-six-per-team',
    slotsPerTeam: 6,
    descriptorRecipe,
    modelNamespace: createHash('sha256').update(stableJson(descriptorRecipe)).digest('hex'),
    tracklets,
  }
}

function norm(values: readonly number[]) {
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0))
}

function normalized(values: readonly number[]) {
  const length = norm(values)
  return values.map(value => length > 1e-12 ? value / length : 0)
}

function featureVector(descriptors: Record<DescriptorName, number[]>, modalities: readonly DescriptorName[]) {
  const scale = Math.sqrt(modalities.length)
  return modalities.flatMap(name => normalized(descriptors[name]).map(value => value / scale))
}

function kernel(left: readonly number[], right: readonly number[], name: KernelName) {
  let cosine = 0
  for (let index = 0; index < left.length; index += 1) cosine += left[index]! * right[index]!
  cosine = Math.max(-1, Math.min(1, cosine))
  if (name === 'linear') return cosine
  if (name === 'cosine2') return Math.max(0, cosine) ** 2
  return Math.exp(-2 * (1 - cosine))
}

function solveLinearSystem(matrix: number[][], targets: number[][]) {
  const width = targets[0]?.length ?? 0
  const augmented = matrix.map((row, index) => [...row, ...targets[index]!])
  for (let column = 0; column < matrix.length; column += 1) {
    let pivot = column
    for (let row = column + 1; row < matrix.length; row += 1) {
      if (Math.abs(augmented[row]![column]!) > Math.abs(augmented[pivot]![column]!)) pivot = row
    }
    ;[augmented[column], augmented[pivot]] = [augmented[pivot]!, augmented[column]!]
    const divisor = augmented[column]![column]!
    if (Math.abs(divisor) < 1e-12) throw new FixedRosterReidError('kernel ridge system is singular')
    for (let value = column; value < matrix.length + width; value += 1) augmented[column]![value]! /= divisor
    for (let row = 0; row < matrix.length; row += 1) {
      if (row === column) continue
      const factor = augmented[row]![column]!
      for (let value = column; value < matrix.length + width; value += 1) {
        augmented[row]![value]! -= factor * augmented[column]![value]!
      }
    }
  }
  return augmented.map(row => row.slice(matrix.length))
}

function fitAndScore(train: HistoricalRow[], query: Record<DescriptorName, number[]>, candidate: NestedCandidate) {
  const labels = [...new Set(train.map(row => row.label))].sort()
  const labelIndex = new Map(labels.map((label, index) => [label, index]))
  const vectors = train.map(row => featureVector(row.descriptors, candidate.modalities))
  const mean = vectors[0]!.map((_, column) => vectors.reduce((sum, row) => sum + row[column]!, 0) / vectors.length)
  const centered = vectors.map(row => normalized(row.map((value, column) => value - mean[column]!)))
  const gram = centered.map((left, row) => centered.map((right, column) =>
    kernel(left, right, candidate.kernel) + (row === column ? candidate.regularization : 0)))
  const targets = train.map(row => labels.map(label => Number(label === row.label)))
  const dual = solveLinearSystem(gram, targets)
  const queryVector = normalized(featureVector(query, candidate.modalities).map((value, column) => value - mean[column]!))
  const scores = labels.map((_, labelColumn) => centered.reduce((sum, row, trainIndex) =>
    sum + kernel(queryVector, row, candidate.kernel) * dual[trainIndex]![labelColumn]!, 0))
  return Object.fromEntries(labels.map((label, index) => [label, scores[index]!]))
}

function modalitySubsets() {
  const output: DescriptorName[][] = []
  for (let mask = 1; mask < 1 << MODALITIES.length; mask += 1) {
    output.push(MODALITIES.filter((_, index) => (mask & (1 << index)) !== 0))
  }
  return output.sort((left, right) => left.length - right.length || left.join(',').localeCompare(right.join(',')))
}

export function selectNestedCandidate(history: HistoricalRow[]): NestedCandidate {
  const clips = [...new Set(history.map(row => row.clipId))].sort()
  if (clips.length < 3) return { modalities: ['kpr_prompt'], regularization: 0.1, kernel: 'linear' }
  let best: { hits: number; candidate: NestedCandidate } | null = null
  for (const modalities of modalitySubsets()) {
    for (const regularization of REGULARIZATIONS) {
      for (const kernelName of KERNELS) {
        const candidate = { modalities, regularization, kernel: kernelName }
        let hits = 0
        for (const heldOut of clips) {
          const train = history.filter(row => row.clipId !== heldOut)
          for (const query of history.filter(row => row.clipId === heldOut)) {
            if (!train.length) continue
            const scores = fitAndScore(train, query.descriptors, candidate)
            const predicted = Object.entries(scores).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0]
            if (predicted === query.label) hits += 1
          }
        }
        if (!best || hits > best.hits
          || (hits === best.hits && modalities.length < best.candidate.modalities.length)
          || (hits === best.hits && modalities.length === best.candidate.modalities.length
            && modalities.join(',').localeCompare(best.candidate.modalities.join(',')) > 0)) {
          best = { hits, candidate }
        }
      }
    }
  }
  return best!.candidate
}

interface SlotIdentity {
  id: string
  teamId: string
  slotIndex: number
}

export function solveSlots(
  tracklets: FixedRosterTracklet[],
  candidates: Map<number, SlotIdentity[]>,
  scores: Map<string, number>,
  fixed: Map<number, string> = new Map(),
) {
  const assigned = new Map<number, string>()
  let best: { assignedCount: number; score: number; assignments: Map<number, string> } | null = null
  const ordered = [...tracklets].sort((left, right) =>
    right.cannotLinkCanonicalTrackIds.length - left.cannotLinkCanonicalTrackIds.length
    || right.sampleCount - left.sampleCount || left.canonicalTrackId - right.canonicalTrackId)
  const visit = (index: number, total: number) => {
    if (index === ordered.length) {
      if (!best || assigned.size > best.assignedCount
        || (assigned.size === best.assignedCount && total > best.score)) {
        best = { assignedCount: assigned.size, score: total, assignments: new Map(assigned) }
      }
      return
    }
    const tracklet = ordered[index]!
    const forced = fixed.get(tracklet.canonicalTrackId)
    const options = (candidates.get(tracklet.canonicalTrackId) ?? [])
      .filter(slot => !forced || slot.id === forced)
      .sort((left, right) => (scores.get(`${tracklet.canonicalTrackId}:${right.id}`) ?? 0)
        - (scores.get(`${tracklet.canonicalTrackId}:${left.id}`) ?? 0) || left.slotIndex - right.slotIndex)
    for (const slot of options) {
      if (tracklet.cannotLinkCanonicalTrackIds.some(linked => assigned.get(linked) === slot.id)) continue
      assigned.set(tracklet.canonicalTrackId, slot.id)
      visit(index + 1, total + (scores.get(`${tracklet.canonicalTrackId}:${slot.id}`) ?? 0))
      assigned.delete(tracklet.canonicalTrackId)
    }
    // A detector/bench tracklet can overlap all six active slots across
    // different frames.  It must remain G--- rather than inventing S7 or
    // making the entire clip unsatisfiable.  Seeded first-clip roster members
    // are never skipped.
    if (!forced) visit(index + 1, total)
  }
  visit(0, 0)
  if (!best) throw new FixedRosterReidError('fixed roster constraints have no valid six-slot assignment')
  return (best as { assignedCount: number; score: number; assignments: Map<number, string> }).assignments
}

const activeObservationScope = {
  track: { analysisRun: { supersededAt: null, submission: { activeForRally: { isNot: null } } } },
} as const

function canonicalBefore(position: { setNumber: number; rallyOrdinal: number }) {
  return { OR: [
    { setNumber: { lt: position.setNumber } },
    { setNumber: position.setNumber, rallyOrdinal: { lt: position.rallyOrdinal } },
  ] }
}

function descriptorBytes(values: readonly number[] | undefined) {
  if (!values) return null
  const bytes = Buffer.alloc(values.length * 4)
  values.forEach((value, index) => bytes.writeFloatLE(value, index * 4))
  return bytes
}

function decodedDescriptor(value: Uint8Array | null, dimension: number) {
  if (!value || value.byteLength !== dimension * 4) throw new FixedRosterReidError('persisted descriptor has an invalid size')
  const bytes = Buffer.from(value)
  return Array.from({ length: dimension }, (_, index) => bytes.readFloatLE(index * 4))
}

async function ensureSlots(tx: TransactionClient, input: {
  matchId: string
  teamIds: string[]
  revision: bigint
}) {
  const slots: SlotIdentity[] = []
  for (const teamId of input.teamIds) {
    for (let slotIndex = 1; slotIndex <= SLOT_COUNT; slotIndex += 1) {
      const id = randomUUID()
      const identity = await tx.reidIdentity.upsert({
        where: { matchId_teamId_slotIndex: {
          matchId: input.matchId, teamId, slotIndex,
        } },
        create: {
          id, matchId: input.matchId, teamId, modelNamespace: FIXED_ROSTER_IDENTITY_NAMESPACE,
          modelName: 'fixed-roster-slot', modelCheckpointSha256: FIXED_ROSTER_IDENTITY_NAMESPACE,
          modelPreprocessVersion: 'fixed-roster-v2', modelDimension: 0,
          modelDistance: 'slot', label: `S${slotIndex}`, slotIndex,
          createdRevision: input.revision,
        },
        update: {},
        select: { id: true, teamId: true, slotIndex: true },
      })
      slots.push(identity)
    }
  }
  return slots
}

export async function ingestFixedRosterReid(tx: TransactionClient, input: {
  analysisRunId: string
  matchId: string
  leftTeamId: string
  rightTeamId: string
  setNumber: number
  rallyOrdinal: number
  featureBank: ParsedFixedRosterReid | null
}) {
  if (!input.featureBank || input.featureBank.tracklets.length === 0) {
    return { identityRevision: null, observationCount: 0, propagatedCount: 0 }
  }
  await tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${input.matchId}::uuid FOR UPDATE`
  const match = await tx.match.update({
    where: { id: input.matchId }, data: { identityRevision: { increment: 1 } },
    select: { identityRevision: true },
  })
  const revision = match.identityRevision
  const position = { setNumber: input.setNumber, rallyOrdinal: input.rallyOrdinal }
  const slots = await ensureSlots(tx, {
    matchId: input.matchId,
    teamIds: [input.leftTeamId, input.rightTeamId],
    revision,
  })
  const persisted = await tx.reidFeatureObservation.findMany({
    where: {
      analysisRunId: { not: input.analysisRunId }, matchId: input.matchId,
      modelNamespace: input.featureBank.modelNamespace, reidIdentityId: { not: null },
      isCanonicalTrack: true, dinoDescriptor: { not: null }, osnetDescriptor: { not: null },
      kprDescriptor: { not: null }, kprPromptDescriptor: { not: null },
      ...activeObservationScope, ...canonicalBefore(position),
    },
    select: {
      analysisRunId: true, teamId: true,
      reidIdentity: { select: { id: true, label: true, slotIndex: true } },
      dinoDescriptor: true, osnetDescriptor: true, kprDescriptor: true, kprPromptDescriptor: true,
    },
  })
  const historyByTeam = new Map<string, HistoricalRow[]>()
  for (const row of persisted) {
    if (!row.teamId || !row.reidIdentity) continue
    const history = historyByTeam.get(row.teamId) ?? []
    history.push({
      clipId: row.analysisRunId,
      label: `S${row.reidIdentity.slotIndex}`,
      descriptors: {
        dino: decodedDescriptor(row.dinoDescriptor, 384),
        osnet: decodedDescriptor(row.osnetDescriptor, 512),
        kpr: decodedDescriptor(row.kprDescriptor, 4096),
        kpr_prompt: decodedDescriptor(row.kprPromptDescriptor, 4096),
      },
    })
    historyByTeam.set(row.teamId, history)
  }

  const assigned = new Map<number, SlotIdentity>()
  const selectedByTeam = new Map<string, NestedCandidate>()
  for (const [side, teamId] of [['left', input.leftTeamId], ['right', input.rightTeamId]] as const) {
    const tracklets = input.featureBank.tracklets.filter(tracklet => tracklet.courtSide === side)
    if (!tracklets.length) continue
    const teamSlots = slots.filter(slot => slot.teamId === teamId)
    const candidates = new Map(tracklets.map(tracklet => [tracklet.canonicalTrackId, teamSlots]))
    const scores = new Map<string, number>()
    const fixed = new Map<number, string>()
    const history = historyByTeam.get(teamId) ?? []
    const candidate = selectNestedCandidate(history)
    selectedByTeam.set(teamId, candidate)
    if (history.length) {
      for (const tracklet of tracklets) {
        if (!tracklet.descriptors) continue
        const labelScores = fitAndScore(history, tracklet.descriptors, candidate)
        for (const slot of teamSlots) scores.set(`${tracklet.canonicalTrackId}:${slot.id}`, labelScores[`S${slot.slotIndex}`] ?? -1)
      }
    } else {
      const seeds = [...tracklets].sort((left, right) => right.sampleCount - left.sampleCount
        || right.meanQuality - left.meanQuality || left.canonicalTrackId - right.canonicalTrackId)
        .slice(0, SLOT_COUNT)
        .sort((left, right) => (left.medianCourtPos?.[1] ?? Infinity) - (right.medianCourtPos?.[1] ?? Infinity)
          || (left.medianCourtPos?.[0] ?? Infinity) - (right.medianCourtPos?.[0] ?? Infinity)
          || left.canonicalTrackId - right.canonicalTrackId)
      seeds.forEach((tracklet, index) => fixed.set(tracklet.canonicalTrackId, teamSlots[index]!.id))
      for (const tracklet of tracklets) for (const seed of seeds) {
        const seedSlot = teamSlots[seeds.indexOf(seed)]!
        const score = tracklet.descriptors && seed.descriptors
          ? kernel(normalized(tracklet.descriptors.kpr_prompt), normalized(seed.descriptors.kpr_prompt), 'linear')
          : 0
        scores.set(`${tracklet.canonicalTrackId}:${seedSlot.id}`, score)
      }
    }
    for (const [trackId, identityId] of solveSlots(tracklets, candidates, scores, fixed)) {
      assigned.set(trackId, teamSlots.find(slot => slot.id === identityId)!)
    }
  }

  const unknownTracklets = input.featureBank.tracklets.filter(tracklet => tracklet.courtSide === 'unknown')
  if (unknownTracklets.length) {
    const candidates = new Map<number, SlotIdentity[]>()
    const scores = new Map<string, number>()
    for (const tracklet of unknownTracklets) {
      const viable: SlotIdentity[] = []
      if (tracklet.descriptors) {
        for (const teamId of [input.leftTeamId, input.rightTeamId]) {
          const history = historyByTeam.get(teamId) ?? []
          if (!history.length) continue
          const candidate = selectNestedCandidate(history)
          selectedByTeam.set(teamId, candidate)
          const labelScores = fitAndScore(history, tracklet.descriptors, candidate)
          for (const slot of slots.filter(item => item.teamId === teamId
            && !tracklet.cannotLinkCanonicalTrackIds.some(linked => assigned.get(linked)?.id === item.id))) {
            viable.push(slot)
            scores.set(`${tracklet.canonicalTrackId}:${slot.id}`, labelScores[`S${slot.slotIndex}`] ?? -1)
          }
        }
      }
      candidates.set(tracklet.canonicalTrackId, viable)
    }
    if ([...candidates.values()].every(value => value.length > 0)) {
      for (const [trackId, identityId] of solveSlots(unknownTracklets, candidates, scores)) {
        assigned.set(trackId, slots.find(slot => slot.id === identityId)!)
      }
    }
  }

  let observationCount = 0
  let propagatedCount = 0
  for (const tracklet of input.featureBank.tracklets) {
    const slot = assigned.get(tracklet.canonicalTrackId)
    const candidate = slot ? selectedByTeam.get(slot.teamId) : undefined
    const sidePrefix = tracklet.courtSide === 'left' ? 'L' : tracklet.courtSide === 'right' ? 'R' : 'G'
    const slotHistory = slot ? historyByTeam.get(slot.teamId) ?? [] : []
    const matchConfidence = slot && tracklet.descriptors && candidate && slotHistory.length
      ? fitAndScore(slotHistory, tracklet.descriptors, candidate)[`S${slot.slotIndex}`] ?? null
      : null
    const binding = slot ? await tx.reidPlayerBinding.findFirst({
      where: { reidIdentityId: slot.id, OR: [
        { effectiveFromSetNumber: { lt: position.setNumber } },
        { effectiveFromSetNumber: position.setNumber, effectiveFromRallyOrdinal: { lte: position.rallyOrdinal } },
      ] },
      orderBy: [{ effectiveFromSetNumber: 'desc' }, { effectiveFromRallyOrdinal: 'desc' }, { identityRevision: 'desc' }],
    }) : null
    for (const trackId of tracklet.trackIds) {
      await tx.reidFeatureObservation.create({ data: {
        analysisRunId: input.analysisRunId, trackId, matchId: input.matchId,
        teamId: slot?.teamId ?? null, reidIdentityId: slot?.id ?? null,
        modelNamespace: input.featureBank.modelNamespace, modelName: 'nested-part-adaptation',
        modelCheckpointSha256: input.featureBank.modelNamespace,
        modelPreprocessVersion: 'nested-part-adaptation-v1', modelDimension: 9088,
        modelDistance: 'kernel-ridge', courtSide: tracklet.courtSide.toUpperCase() as TrackCourtSide,
        provisionalGid: slot ? `${sidePrefix}${slot.slotIndex}` : 'G---',
        canonicalTrackId: tracklet.canonicalTrackId, isCanonicalTrack: trackId === tracklet.canonicalTrackId,
        aliasTrackIds: tracklet.trackIds, medianCourtX: tracklet.medianCourtPos?.[0] ?? null,
        medianCourtY: tracklet.medianCourtPos?.[1] ?? null,
        descriptorRecipe: input.featureBank.descriptorRecipe as Prisma.InputJsonValue,
        dinoDescriptor: descriptorBytes(tracklet.descriptors?.dino),
        osnetDescriptor: descriptorBytes(tracklet.descriptors?.osnet),
        kprDescriptor: descriptorBytes(tracklet.descriptors?.kpr),
        kprPromptDescriptor: descriptorBytes(tracklet.descriptors?.kpr_prompt),
        promptCoverage: tracklet.promptCoverage,
        selectedModalities: candidate?.modalities ?? ['kpr_prompt'],
        selectedKernel: candidate?.kernel ?? 'linear',
        selectedRegularization: candidate?.regularization ?? 0.1,
        firstFrame: tracklet.firstFrame, lastFrame: tracklet.lastFrame,
        sampleCount: tracklet.sampleCount, meanQuality: tracklet.meanQuality,
        prototype: descriptorBytes(tracklet.descriptors?.osnet) ?? Buffer.alloc(512 * 4),
        cannotLinkTrackIds: tracklet.cannotLinkCanonicalTrackIds,
        setNumber: position.setNumber, rallyOrdinal: position.rallyOrdinal,
        matchConfidence, identityRevision: revision,
      } })
      observationCount += 1
      if (!slot || !binding?.rosterEntryId) continue
      const existing = await tx.trackIdentityAssignment.findUnique({
        where: { analysisRunId_trackId: { analysisRunId: input.analysisRunId, trackId } },
        select: { source: true },
      })
      if (existing?.source === IdentitySource.MANUAL) continue
      await tx.trackIdentityAssignment.upsert({
        where: { analysisRunId_trackId: { analysisRunId: input.analysisRunId, trackId } },
        create: {
          analysisRunId: input.analysisRunId, trackId, rosterEntryId: binding.rosterEntryId,
          source: IdentitySource.PROPAGATED, confidence: matchConfidence,
          reidIdentityId: slot.id, reidBindingId: binding.id, identityRevision: revision,
        },
        update: {
          rosterEntryId: binding.rosterEntryId, source: IdentitySource.PROPAGATED,
          assignedByUserId: null, confidence: matchConfidence,
          reidIdentityId: slot.id, reidBindingId: binding.id, identityRevision: revision,
        },
      })
      propagatedCount += 1
    }
  }
  return { identityRevision: revision, observationCount, propagatedCount }
}

export type ReidIdentityMode = 'from_here' | 'clip_only' | 'split_identity'

export class ReidIdentityDecisionError extends Error {
  constructor(
    readonly code: 'REID_IDENTITY_REQUIRED' | 'REID_OBSERVATION_NOT_FOUND' | 'REID_TEAM_MISMATCH' | 'REID_ASSIGNMENT_FAILED',
    message: string,
  ) {
    super(message)
    this.name = 'ReidIdentityDecisionError'
  }
}

export function parseReidIdentityMode(value: unknown): ReidIdentityMode {
  if (value === undefined || value === null || value === '') return 'from_here'
  if (value === 'from_here' || value === 'clip_only' || value === 'split_identity') return value
  throw new TypeError('identityMode must be from_here, clip_only or split_identity')
}

export async function applyManualReidDecision(tx: TransactionClient, input: {
  matchId: string
  teamId: string
  analysisRunId: string
  trackId: number
  rosterEntryId: string
  userId: string
  position: { setNumber: number; rallyOrdinal: number }
  mode: ReidIdentityMode
  replacedTrackIds: number[]
}) {
  const observation = await tx.reidFeatureObservation.findUnique({
    where: { analysisRunId_trackId: { analysisRunId: input.analysisRunId, trackId: input.trackId } },
    include: { reidIdentity: true },
  })
  if (!observation) {
    throw new ReidIdentityDecisionError('REID_OBSERVATION_NOT_FOUND', 'This track has no fixed-roster ReID observation')
  }
  await tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${input.matchId}::uuid FOR UPDATE`
  const match = await tx.match.update({
    where: { id: input.matchId }, data: { identityRevision: { increment: 1 } },
    select: { identityRevision: true },
  })
  const revision = match.identityRevision
  const existingPlayerSlot = await tx.reidPlayerBinding.findFirst({
    where: {
      rosterEntryId: input.rosterEntryId,
      reidIdentity: {
        matchId: input.matchId, teamId: input.teamId,
      },
      OR: [
        { effectiveFromSetNumber: { lt: input.position.setNumber } },
        { effectiveFromSetNumber: input.position.setNumber,
          effectiveFromRallyOrdinal: { lte: input.position.rallyOrdinal } },
      ],
    },
    orderBy: [{ effectiveFromSetNumber: 'desc' }, { effectiveFromRallyOrdinal: 'desc' }, { identityRevision: 'desc' }],
    include: { reidIdentity: true },
  })
  const currentIdentity = observation.reidIdentity?.teamId === input.teamId
    ? observation.reidIdentity
    : null
  const targetIdentity = existingPlayerSlot?.reidIdentity ?? currentIdentity
  if (!targetIdentity) {
    throw new ReidIdentityDecisionError(
      observation.reidIdentity ? 'REID_TEAM_MISMATCH' : 'REID_IDENTITY_REQUIRED',
      'Run fixed-roster ReID first so this track can be assigned to one of the six team slots',
    )
  }

  const aliases = observation.aliasTrackIds
  const sourceIdentityId = observation.reidIdentityId
  const sidePrefix = observation.courtSide === TrackCourtSide.LEFT
    ? 'L'
    : observation.courtSide === TrackCourtSide.RIGHT ? 'R' : 'G'
  if (targetIdentity.id !== sourceIdentityId) {
    await tx.reidFeatureObservation.updateMany({
      where: { analysisRunId: input.analysisRunId, trackId: { in: aliases } },
      data: {
        teamId: input.teamId, reidIdentityId: targetIdentity.id,
        provisionalGid: `${sidePrefix}${targetIdentity.slotIndex}`,
        matchConfidence: null, identityRevision: revision,
      },
    })
  }

  let binding: { id: string } | null = null
  if (input.mode !== 'clip_only') {
    binding = await tx.reidPlayerBinding.create({
      data: {
        reidIdentityId: targetIdentity.id, rosterEntryId: input.rosterEntryId,
        sourceObservationId: observation.id,
        effectiveFromSetNumber: input.position.setNumber,
        effectiveFromRallyOrdinal: input.position.rallyOrdinal,
        source: IdentitySource.MANUAL, identityRevision: revision,
        assignedByUserId: input.userId,
      },
      select: { id: true },
    })
  }
  let selectedAssignment: {
    id: string
    analysisRunId: string
    trackId: number
    rosterEntryId: string
    source: IdentitySource
  } | null = null
  for (const trackId of aliases) {
    const assignment = await tx.trackIdentityAssignment.upsert({
      where: { analysisRunId_trackId: { analysisRunId: input.analysisRunId, trackId } },
      create: {
        analysisRunId: input.analysisRunId, trackId, rosterEntryId: input.rosterEntryId,
        source: IdentitySource.MANUAL, assignedByUserId: input.userId,
        confidence: null, reidIdentityId: targetIdentity.id,
        reidBindingId: binding?.id ?? null, identityRevision: revision,
      },
      update: {
        rosterEntryId: input.rosterEntryId, source: IdentitySource.MANUAL,
        assignedByUserId: input.userId, confidence: null,
        reidIdentityId: targetIdentity.id, reidBindingId: binding?.id ?? null,
        identityRevision: revision,
      },
      select: {
        id: true,
        analysisRunId: true,
        trackId: true,
        rosterEntryId: true,
        source: true,
      },
    })
    if (trackId === input.trackId) selectedAssignment = assignment
  }
  for (const replacedTrackId of input.replacedTrackIds) {
    if (aliases.includes(replacedTrackId)) continue
    await tx.trackIdentityAssignment.deleteMany({
      where: { analysisRunId: input.analysisRunId, trackId: replacedTrackId, rosterEntryId: input.rosterEntryId },
    })
  }

  if (binding) {
    const later = await tx.reidFeatureObservation.findMany({
      where: {
        reidIdentityId: targetIdentity.id,
        OR: [
          { setNumber: { gt: input.position.setNumber } },
          { setNumber: input.position.setNumber, rallyOrdinal: { gte: input.position.rallyOrdinal } },
        ],
      },
      select: { analysisRunId: true, trackId: true, matchConfidence: true },
    })
    for (const item of later) {
      const existing = await tx.trackIdentityAssignment.findUnique({
        where: { analysisRunId_trackId: { analysisRunId: item.analysisRunId, trackId: item.trackId } },
        select: { source: true },
      })
      if (existing?.source === IdentitySource.MANUAL) continue
      await tx.trackIdentityAssignment.upsert({
        where: { analysisRunId_trackId: { analysisRunId: item.analysisRunId, trackId: item.trackId } },
        create: {
          analysisRunId: item.analysisRunId, trackId: item.trackId,
          rosterEntryId: input.rosterEntryId, source: IdentitySource.PROPAGATED,
          confidence: item.matchConfidence, reidIdentityId: targetIdentity.id,
          reidBindingId: binding.id, identityRevision: revision,
        },
        update: {
          rosterEntryId: input.rosterEntryId, source: IdentitySource.PROPAGATED,
          assignedByUserId: null, confidence: item.matchConfidence,
          reidIdentityId: targetIdentity.id, reidBindingId: binding.id,
          identityRevision: revision,
        },
      })
    }
  }

  await tx.reidCorrectionEvent.create({ data: {
    matchId: input.matchId, teamId: input.teamId, analysisRunId: input.analysisRunId,
    trackId: input.trackId, sourceIdentityId, targetIdentityId: targetIdentity.id,
    rosterEntryId: input.rosterEntryId,
    kind: input.mode === 'clip_only' ? 'CLIP_ONLY' : input.mode === 'split_identity' ? 'SPLIT_IDENTITY' : 'FROM_HERE',
    identityRevision: revision, createdByUserId: input.userId,
    details: {
      fixed_slot: targetIdentity.slotIndex,
      aliases,
      replaced_track_ids: input.replacedTrackIds,
    },
  } })
  if (!selectedAssignment) {
    throw new ReidIdentityDecisionError('REID_ASSIGNMENT_FAILED', 'The selected track alias was not assigned')
  }
  return {
    bindingId: binding?.id ?? null,
    reidIdentityId: targetIdentity.id,
    identityRevision: revision,
    assignment: selectedAssignment,
  }
}
