import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { PrismaClient } from '@volleyball-monitoring/db'
import {
  ArtifactState,
  IdentitySource,
  JobStatus,
  MediaAssetKind,
  Prisma,
  ProviderArtifactDirection,
  ProviderWorkKind,
  ReidAssociationState,
  ReidEvidenceRole,
  ReidEvidenceState,
  TrackCourtSide,
} from '@volleyball-monitoring/db/client'
import Ajv2020 from 'ajv/dist/2020.js'
import {
  buildReidBankSnapshot,
  canonicalJson,
  isRecord,
  sha256Hex,
  UUID_PATTERN,
  verifiedSemanticContentSha,
} from '../services/reid-artifacts.js'
import { createPollingLifecycle } from '../workflow/poller.js'
import {
  createWorkflowMinio,
  putVerifiedBuffer,
  readVerifiedObject,
  type WorkflowMinio,
} from '../workflow/minio.js'

const ASSOCIATION_LEASE_MS = 5 * 60_000
const JSON_MAX_BYTES = 32n * 1024n * 1024n
const ASSOCIATION_RECIPE = 'reid/nested-part-v2'
const contractsRoot = new URL('../../../packages/contracts/ai/', import.meta.url)
const ajv = new Ajv2020({ allErrors: true, strict: false })
const validateBankSnapshot = ajv.compile(
  JSON.parse(await readFile(new URL('reid-bank-snapshot.schema.json', contractsRoot), 'utf8')),
)
const validateAssociationRequest = ajv.compile(
  JSON.parse(await readFile(new URL('reid-association-job.schema.json', contractsRoot), 'utf8')),
)
const validateAssociationResult = ajv.compile(
  JSON.parse(await readFile(new URL('reid-association-result.schema.json', contractsRoot), 'utf8')),
)

export function reidAssociationIdempotencyKey(input: {
  evidenceSetId: string
  teamId: string
  bankContentSha256: string
  rerunRequestId?: string | null
}) {
  return `reid-association:${sha256Hex(canonicalJson(input))}`
}

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
const records = (value: unknown) => (Array.isArray(value) ? value.filter(isRecord) : [])

type AssociationArtifact = {
  artifactKind: string
  sha256: string
  byteLength: bigint
  mediaAsset: {
    id: string
    bucket: string
    objectKey: string
    byteLength: bigint | null
    sha256: string | null
  }
}

export class ReidAssociationMaterializationError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'ReidAssociationMaterializationError'
  }
}

function materializationError(error: unknown, retryable = false): never {
  if (error instanceof ReidAssociationMaterializationError) throw error
  throw new ReidAssociationMaterializationError(
    error instanceof Error ? error.message : 'invalid ReID association artifact',
    retryable,
  )
}

function beforePosition(
  setNumber: number,
  rallyOrdinal: number,
  currentSetNumber: number,
  currentRallyOrdinal: number,
) {
  return (
    setNumber < currentSetNumber ||
    (setNumber === currentSetNumber && rallyOrdinal < currentRallyOrdinal)
  )
}

type AssociationRevisionRun = {
  status: JobStatus
  rerunRequestId?: string | null
  bankSnapshot: { teamId: string; revision: bigint; derivationVersion: string }
}

const REID_BANK_DERIVATION_VERSION = 'active-history-capped-gid-v5'

export function isReidBankSeedMembership(input: {
  evidenceState: ReidEvidenceState
  setNumber: number
  rallyOrdinal: number
  currentSetNumber: number
  currentRallyOrdinal: number
}) {
  const isPrior = beforePosition(
    input.setNumber,
    input.rallyOrdinal,
    input.currentSetNumber,
    input.currentRallyOrdinal,
  )
  if (input.evidenceState === ReidEvidenceState.UNVERIFIED) return isPrior
  return (
    input.evidenceState === ReidEvidenceState.CONFIRMED &&
    (isPrior ||
      (input.setNumber === input.currentSetNumber &&
        input.rallyOrdinal === input.currentRallyOrdinal))
  )
}

export type CappedGidTracklet = {
  id: string
  firstFrameIndex: bigint
  lastFrameIndex: bigint
  cannotLinkTrackletIds: string[]
}

export type CappedGidDecision = Record<string, unknown> & {
  tracklet_id: string
  action: 'MATCH_EXISTING_GID' | 'CREATE_NEW_GID'
  selected_person_cluster_id: string | null
  selected_roster_entry_id: string | null
  new_gid_group_key: string | null
  confidence: number
  candidates: Record<string, unknown>[]
}

export type CappedGidResolution = {
  trackletId: string
  personClusterKey: string
  createGroupKey: string | null
  rosterEntryId: string | null
  confidence: number
  providerAction: 'MATCH_EXISTING_GID' | 'CREATE_NEW_GID'
}

/**
 * A range overlap by itself is not proof that two Local IDs were observed together because a
 * tracklet may contain missed detections. Overflow capacity therefore requires the provider's
 * symmetric CO_VISIBILITY cannot-link evidence as well as overlapping canonical-frame ranges.
 * A clique is a set in which every Local ID is proven distinct from every other Local ID; interval
 * pairwise overlap then guarantees that their inclusive presence ranges share a frame.
 */
export function maximumSameFrameTeamCount(tracklets: CappedGidTracklet[]) {
  if (tracklets.length === 0) return 0
  const neighbors = new Map(tracklets.map(tracklet => [tracklet.id, new Set<string>()]))
  for (let leftIndex = 0; leftIndex < tracklets.length; leftIndex += 1) {
    const left = tracklets[leftIndex]!
    for (let rightIndex = leftIndex + 1; rightIndex < tracklets.length; rightIndex += 1) {
      const right = tracklets[rightIndex]!
      const rangesOverlap =
        left.firstFrameIndex <= right.lastFrameIndex && right.firstFrameIndex <= left.lastFrameIndex
      const coVisible =
        left.cannotLinkTrackletIds.includes(right.id) &&
        right.cannotLinkTrackletIds.includes(left.id)
      if (!rangesOverlap || !coVisible) continue
      neighbors.get(left.id)!.add(right.id)
      neighbors.get(right.id)!.add(left.id)
    }
  }

  let maximum = 1
  const search = (cliqueSize: number, candidates: string[]) => {
    if (cliqueSize + candidates.length <= maximum) return
    while (candidates.length > 0) {
      if (cliqueSize + candidates.length <= maximum) return
      const candidate = candidates.shift()!
      const nextSize = cliqueSize + 1
      maximum = Math.max(maximum, nextSize)
      search(
        nextSize,
        candidates.filter(id => neighbors.get(candidate)!.has(id)),
      )
    }
  }
  search(
    0,
    tracklets.map(tracklet => tracklet.id),
  )
  return maximum
}

/**
 * Central is the final persistence gate for GIDs. Provider CREATE_NEW_GID responses are proposals:
 * the first six team GIDs may be materialized, and an overflow slot is legal only when the current
 * evidence proves that many same-team Local IDs on one canonical frame. Once the pool is full,
 * candidate-ranked existing GIDs are reused in-memory and no new ReidPersonCluster row is created.
 */
export function planCappedGidResolutions(input: {
  decisions: CappedGidDecision[]
  tracklets: CappedGidTracklet[]
  existingGids: Array<{ id: string; rosterEntryId: string | null }>
  baselineCount?: number
}) {
  const baselineCount = input.baselineCount ?? 6
  const allowedCount = Math.max(baselineCount, maximumSameFrameTeamCount(input.tracklets))
  const existingPool = input.existingGids.slice(0, allowedCount)
  const rosterByCluster = new Map(existingPool.map(gid => [gid.id, gid.rosterEntryId]))
  const slotKeys = existingPool.map(gid => gid.id)
  for (let index = existingPool.length; index < allowedCount; index += 1)
    slotKeys.push(`__new_gid_slot_${index + 1}`)

  const trackletsById = new Map(input.tracklets.map(tracklet => [tracklet.id, tracklet]))
  const assignedTrackletsBySlot = new Map<string, string[]>()
  const newSlotByProviderGroup = new Map<string, string>()
  const resolutions = new Map<string, CappedGidResolution>()
  const ordered = [...input.decisions].sort((left, right) => {
    const leftTracklet = trackletsById.get(left.tracklet_id)
    const rightTracklet = trackletsById.get(right.tracklet_id)
    if (!leftTracklet || !rightTracklet) return left.tracklet_id.localeCompare(right.tracklet_id)
    if (leftTracklet.firstFrameIndex !== rightTracklet.firstFrameIndex)
      return leftTracklet.firstFrameIndex < rightTracklet.firstFrameIndex ? -1 : 1
    return left.tracklet_id.localeCompare(right.tracklet_id)
  })

  for (const decision of ordered) {
    const tracklet = trackletsById.get(decision.tracklet_id)
    if (!tracklet)
      throw new ReidAssociationMaterializationError(
        'capped GID policy is missing an eligible tracklet',
        false,
      )
    const candidates = [...decision.candidates].sort(
      (left, right) =>
        Number(left.rank ?? Number.MAX_SAFE_INTEGER) -
        Number(right.rank ?? Number.MAX_SAFE_INTEGER),
    )
    const candidateByCluster = new Map(
      candidates
        .filter(candidate => typeof candidate.person_cluster_id === 'string')
        .map(candidate => [String(candidate.person_cluster_id), candidate]),
    )
    const preferred: string[] = []
    if (
      decision.action === 'MATCH_EXISTING_GID' &&
      decision.selected_person_cluster_id &&
      slotKeys.includes(decision.selected_person_cluster_id)
    )
      preferred.push(decision.selected_person_cluster_id)
    if (decision.action === 'CREATE_NEW_GID' && decision.new_gid_group_key) {
      const existingNewSlot = newSlotByProviderGroup.get(decision.new_gid_group_key)
      if (existingNewSlot) preferred.push(existingNewSlot)
      else {
        const availableNewSlot = slotKeys.find(
          slot =>
            slot.startsWith('__new_gid_slot_') &&
            ![...newSlotByProviderGroup.values()].includes(slot),
        )
        if (availableNewSlot) {
          newSlotByProviderGroup.set(decision.new_gid_group_key, availableNewSlot)
          preferred.push(availableNewSlot)
        }
      }
    }
    preferred.push(
      ...candidates.map(candidate => String(candidate.person_cluster_id ?? '')).filter(Boolean),
    )
    preferred.push(...slotKeys)

    const selectedSlot = [...new Set(preferred)].find(slot => {
      if (!slotKeys.includes(slot)) return false
      const occupants = assignedTrackletsBySlot.get(slot) ?? []
      return occupants.every(occupantId => {
        const occupant = trackletsById.get(occupantId)
        return !(
          tracklet.cannotLinkTrackletIds.includes(occupantId) ||
          occupant?.cannotLinkTrackletIds.includes(tracklet.id)
        )
      })
    })
    if (!selectedSlot)
      throw new ReidAssociationMaterializationError(
        `same-frame team occupancy requires more than ${allowedCount} GIDs`,
        false,
      )
    const occupants = assignedTrackletsBySlot.get(selectedSlot) ?? []
    occupants.push(tracklet.id)
    assignedTrackletsBySlot.set(selectedSlot, occupants)
    const selectedCandidate = candidateByCluster.get(selectedSlot)
    resolutions.set(tracklet.id, {
      trackletId: tracklet.id,
      personClusterKey: selectedSlot,
      createGroupKey: selectedSlot.startsWith('__new_gid_slot_') ? selectedSlot : null,
      rosterEntryId: selectedSlot.startsWith('__new_gid_slot_')
        ? null
        : (rosterByCluster.get(selectedSlot) ??
          (typeof selectedCandidate?.roster_entry_id === 'string'
            ? selectedCandidate.roster_entry_id
            : null)),
      confidence:
        typeof selectedCandidate?.confidence === 'number'
          ? selectedCandidate.confidence
          : decision.confidence,
      providerAction: decision.action,
    })
  }

  return { allowedCount, resolutions }
}

export function hasReidAssociationRevision(
  runs: AssociationRevisionRun[],
  teamId: string,
  revision: bigint,
) {
  return runs.some(
    run =>
      run.status !== JobStatus.CANCELLED &&
      run.status !== JobStatus.FAILED &&
      run.bankSnapshot.teamId === teamId &&
      run.bankSnapshot.revision === revision &&
      run.bankSnapshot.derivationVersion === REID_BANK_DERIVATION_VERSION,
  )
}

export function hasReidAssociationRerun(
  runs: AssociationRevisionRun[],
  teamId: string,
  rerunRequestId: string,
) {
  return runs.some(
    run =>
      run.status !== JobStatus.CANCELLED &&
      run.status !== JobStatus.FAILED &&
      run.rerunRequestId === rerunRequestId &&
      run.bankSnapshot.teamId === teamId,
  )
}

async function latestApplicableBankRevision(
  database: PrismaClient,
  matchId: string,
  teamId: string,
  setNumber: number,
  rallyOrdinal: number,
) {
  const [memberships, bindings] = await Promise.all([
    database.reidEvidenceMembership.findMany({
      where: {
        evidenceState: { in: [ReidEvidenceState.CONFIRMED, ReidEvidenceState.UNVERIFIED] },
        personCluster: { matchId, teamId, supersededRevision: null },
        supersededByMemberships: { none: {} },
        tracklet: { vectors: { some: {} } },
      },
      select: {
        personClusterId: true,
        sourceRevision: true,
        evidenceState: true,
        tracklet: {
          select: {
            evidenceSet: {
              select: {
                analysisRun: {
                  select: {
                    submission: {
                      select: {
                        rally: { select: { matchId: true, displaySetNumber: true, ordinal: true } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
    database.reidGidRosterBindingRevision.findMany({
      where: {
        matchId,
        personCluster: { teamId, supersededRevision: null },
        OR: [
          { effectiveFromSetNumber: { lt: setNumber } },
          {
            effectiveFromSetNumber: setNumber,
            effectiveFromRallyOrdinal: { lte: rallyOrdinal },
          },
        ],
      },
      select: { personClusterId: true, revision: true },
    }),
  ])
  const seedMemberships = memberships.filter(membership => {
    const rally = membership.tracklet.evidenceSet.analysisRun.submission.rally
    return (
      rally.matchId === matchId &&
      isReidBankSeedMembership({
        evidenceState: membership.evidenceState,
        setNumber: rally.displaySetNumber,
        rallyOrdinal: rally.ordinal,
        currentSetNumber: setNumber,
        currentRallyOrdinal: rallyOrdinal,
      })
    )
  })
  return resolveReidBankRevision(seedMemberships, bindings)
}

export function resolveReidBankRevision(
  memberships: { personClusterId: string; sourceRevision: bigint }[],
  bindings: { personClusterId: string; revision: bigint }[],
) {
  const seedClusterIds = new Set(memberships.map(row => row.personClusterId))
  return [
    ...memberships.map(row => row.sourceRevision),
    ...bindings.filter(row => seedClusterIds.has(row.personClusterId)).map(row => row.revision),
  ].reduce((maximum, revision) => (revision > maximum ? revision : maximum), 0n)
}

function oneArtifact(artifacts: AssociationArtifact[], kind: string) {
  const matches = artifacts.filter(artifact => artifact.artifactKind === kind)
  if (matches.length !== 1)
    throw new ReidAssociationMaterializationError(
      `association result requires exactly one ${kind} artifact`,
      false,
    )
  return matches[0]!
}

async function readJsonArtifact(storage: WorkflowMinio, artifact: AssociationArtifact) {
  try {
    const parsed: unknown = JSON.parse(
      (await readVerifiedObject(storage.client, artifact.mediaAsset, JSON_MAX_BYTES)).toString(
        'utf8',
      ),
    )
    if (!isRecord(parsed))
      throw new ReidAssociationMaterializationError(
        'association JSON artifact must be an object',
        false,
      )
    return parsed
  } catch (error) {
    materializationError(error, !(error instanceof SyntaxError))
  }
}

export function planReidAssociationDecisions(
  request: Record<string, unknown>,
  result: Record<string, unknown>,
) {
  const eligibleRows = Array.isArray(request.eligible_tracklet_ids)
    ? request.eligible_tracklet_ids.filter((value): value is string => typeof value === 'string')
    : []
  const eligible = new Set(eligibleRows)
  const decisions = records(result.decisions)
  const decisionTrackletIds = decisions.map(decision => decision.tracklet_id)
  const decisionTracklets = new Set(
    decisionTrackletIds.filter((value): value is string => typeof value === 'string'),
  )
  if (
    eligible.size === 0 ||
    eligible.size !== eligibleRows.length ||
    decisions.length !== eligible.size ||
    decisionTracklets.size !== decisions.length ||
    decisionTrackletIds.some(value => typeof value !== 'string' || !eligible.has(value))
  )
    throw new ReidAssociationMaterializationError(
      'association decisions do not exactly cover eligible tracklets',
      false,
    )
  for (const decision of decisions) {
    const action = decision.action
    const confidence = decision.confidence
    if (
      (action !== 'MATCH_EXISTING_GID' && action !== 'CREATE_NEW_GID') ||
      typeof confidence !== 'number' ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    )
      throw new ReidAssociationMaterializationError(
        'association decision action or confidence is invalid',
        false,
      )
    if (
      action === 'MATCH_EXISTING_GID'
        ? typeof decision.selected_person_cluster_id !== 'string' ||
          decision.new_gid_group_key !== null
        : decision.selected_person_cluster_id !== null ||
          decision.selected_roster_entry_id !== null ||
          typeof decision.new_gid_group_key !== 'string' ||
          decision.new_gid_group_key.length === 0
    )
      throw new ReidAssociationMaterializationError(
        'association decision target shape is invalid',
        false,
      )
  }
  const ids = [
    ...eligible,
    ...decisions.flatMap(decision => [
      decision.selected_person_cluster_id,
      decision.selected_roster_entry_id,
      ...records(decision.candidates).flatMap(candidate => [
        candidate.person_cluster_id,
        candidate.roster_entry_id,
      ]),
    ]),
  ].filter((value): value is string => typeof value === 'string')
  if (ids.some(value => !UUID_PATTERN.test(value)))
    throw new ReidAssociationMaterializationError('association database IDs must be UUIDs', false)
  return { eligible, decisions }
}

export async function scheduleReidAssociation(
  database: PrismaClient,
  storage: WorkflowMinio,
): Promise<boolean> {
  const failedReruns = await database.reidAssociationRerunRequest.findMany({
    where: {
      status: JobStatus.RUNNING,
      associationRuns: {
        some: { providerJob: { status: { in: [JobStatus.FAILED, JobStatus.CANCELLED] } } },
      },
    },
    select: {
      id: true,
      associationRuns: {
        where: { providerJob: { status: { in: [JobStatus.FAILED, JobStatus.CANCELLED] } } },
        select: { providerJob: { select: { errorMessage: true } } },
        take: 1,
      },
    },
  })
  for (const request of failedReruns)
    await database.reidAssociationRerunRequest.update({
      where: { id: request.id },
      data: {
        status: JobStatus.FAILED,
        completedAt: new Date(),
        errorMessage:
          request.associationRuns[0]?.providerJob.errorMessage ??
          'ReID association provider failed',
      },
    })
  // A RUNNING request can legitimately wait on an external provider for minutes. Only select it
  // again when one of its evidence-set teams has not been scheduled; otherwise it would starve the
  // entire global poller while its already-created ProviderJob is in flight.
  const queuedRerunRequest = await database.reidAssociationRerunRequest.findFirst({
    where: { status: JobStatus.QUEUED },
    orderBy: { createdAt: 'asc' },
  })
  const runningRerunRequests = queuedRerunRequest
    ? []
    : await database.reidAssociationRerunRequest.findMany({
        where: { status: JobStatus.RUNNING },
        orderBy: { createdAt: 'asc' },
        take: 100,
        include: {
          associationRuns: { select: { bankSnapshot: { select: { teamId: true } } } },
          analysisRun: {
            select: {
              submission: { select: { leftTeamId: true, rightTeamId: true } },
              reidEvidenceSets: {
                where: { status: ArtifactState.READY, supersededAt: null },
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: { tracklets: { select: { courtSide: true } } },
              },
            },
          },
        },
      })
  const actionableRunningRequest = runningRerunRequests.find(request => {
    const evidenceSet = request.analysisRun.reidEvidenceSets[0]
    if (!evidenceSet) return true
    const scheduledTeams = new Set(request.associationRuns.map(run => run.bankSnapshot.teamId))
    const expectedTeams = new Set<string>()
    if (evidenceSet.tracklets.some(tracklet => tracklet.courtSide === TrackCourtSide.LEFT))
      expectedTeams.add(request.analysisRun.submission.leftTeamId)
    if (evidenceSet.tracklets.some(tracklet => tracklet.courtSide === TrackCourtSide.RIGHT))
      expectedTeams.add(request.analysisRun.submission.rightTeamId)
    return [...expectedTeams].some(teamId => !scheduledTeams.has(teamId))
  })
  const rerunRequest = queuedRerunRequest ?? actionableRunningRequest
  const candidates = await database.reidEvidenceSet.findMany({
    where: {
      status: ArtifactState.READY,
      supersededAt: null,
      ...(rerunRequest ? { analysisRunId: rerunRequest.analysisRunId } : {}),
    },
    orderBy: { createdAt: 'asc' },
    take: 20,
    include: {
      resultAsset: true,
      descriptorBundleAsset: true,
      tracklets: {
        select: {
          id: true,
          courtSide: true,
          activeProjection: { select: { sourcePriority: true } },
        },
      },
      associationRuns: { include: { bankSnapshot: true } },
      providerJob: {
        include: {
          artifacts: {
            where: {
              direction: ProviderArtifactDirection.INPUT,
              artifactKind: 'REID_ROSTER_SNAPSHOT',
            },
            include: { mediaAsset: true },
          },
        },
      },
      analysisRun: { include: { submission: { include: { rally: true } } } },
    },
  })
  let selected:
    | {
        evidenceSet: (typeof candidates)[number]
        teamId: string
        eligibleTrackletIds: string[]
      }
    | undefined
  for (const evidenceSet of candidates) {
    const submission = evidenceSet.analysisRun.submission
    const matchId = submission.rally.matchId
    const setNumber = submission.rally.displaySetNumber
    const rallyOrdinal = submission.rally.ordinal
    for (const candidate of [
      { teamId: submission.leftTeamId, side: TrackCourtSide.LEFT },
      { teamId: submission.rightTeamId, side: TrackCourtSide.RIGHT },
    ]) {
      const eligibleTrackletIds = evidenceSet.tracklets
        .filter(
          tracklet =>
            tracklet.courtSide === candidate.side &&
            (tracklet.activeProjection?.sourcePriority ?? 0) < 1_000,
        )
        .map(tracklet => tracklet.id)
      if (eligibleTrackletIds.length === 0) continue
      const revision = await latestApplicableBankRevision(
        database,
        matchId,
        candidate.teamId,
        setNumber,
        rallyOrdinal,
      )
      const alreadyScheduled = rerunRequest
        ? hasReidAssociationRerun(evidenceSet.associationRuns, candidate.teamId, rerunRequest.id)
        : hasReidAssociationRevision(evidenceSet.associationRuns, candidate.teamId, revision)
      if (alreadyScheduled) continue
      selected = { evidenceSet, teamId: candidate.teamId, eligibleTrackletIds }
      break
    }
    if (selected) break
  }
  if (!selected) {
    if (rerunRequest) {
      const incompleteRuns = await database.reidAssociationRun.count({
        where: { rerunRequestId: rerunRequest.id, status: { not: JobStatus.COMPLETED } },
      })
      if (incompleteRuns === 0) {
        await database.reidAssociationRerunRequest.updateMany({
          where: {
            id: rerunRequest.id,
            status: { in: [JobStatus.QUEUED, JobStatus.RUNNING] },
          },
          data: { status: JobStatus.COMPLETED, completedAt: new Date(), errorMessage: null },
        })
        return true
      }
    }
    return false
  }

  const { evidenceSet, teamId, eligibleTrackletIds } = selected
  const submission = evidenceSet.analysisRun.submission
  const matchId = submission.rally.matchId
  const setNumber = submission.rally.displaySetNumber
  const rallyOrdinal = submission.rally.ordinal
  const rosterArtifact = evidenceSet.providerJob.artifacts[0]?.mediaAsset
  if (!rosterArtifact || rosterArtifact.state !== ArtifactState.READY)
    throw new ReidAssociationMaterializationError('immutable roster snapshot is unavailable', true)

  const clusters = await database.reidPersonCluster.findMany({
    where: {
      matchId,
      teamId,
      supersededRevision: null,
      OR: [
        { bindingRevisions: { none: {} } },
        {
          bindingRevisions: {
            some: {
              OR: [
                { effectiveFromSetNumber: { lt: setNumber } },
                {
                  effectiveFromSetNumber: setNumber,
                  effectiveFromRallyOrdinal: { lte: rallyOrdinal },
                },
              ],
            },
          },
        },
      ],
    },
    include: {
      bindingRevisions: {
        where: {
          OR: [
            { effectiveFromSetNumber: { lt: setNumber } },
            {
              effectiveFromSetNumber: setNumber,
              effectiveFromRallyOrdinal: { lte: rallyOrdinal },
            },
          ],
        },
        orderBy: [
          { effectiveFromSetNumber: 'desc' },
          { effectiveFromRallyOrdinal: 'desc' },
          { revision: 'desc' },
        ],
        take: 1,
      },
    },
  })
  const memberships = (
    await database.reidEvidenceMembership.findMany({
      where: {
        evidenceState: { in: [ReidEvidenceState.CONFIRMED, ReidEvidenceState.UNVERIFIED] },
        personCluster: { matchId, teamId, supersededRevision: null },
        supersededByMemberships: { none: {} },
      },
      include: {
        personCluster: true,
        tracklet: {
          include: {
            vectors: true,
            evidenceSet: {
              include: {
                descriptorBundleAsset: true,
                analysisRun: { include: { submission: { include: { rally: true } } } },
              },
            },
          },
        },
      },
    })
  ).filter(membership => {
    const prior = membership.tracklet.evidenceSet.analysisRun.submission.rally
    return isReidBankSeedMembership({
      evidenceState: membership.evidenceState,
      setNumber: prior.displaySetNumber,
      rallyOrdinal: prior.ordinal,
      currentSetNumber: setNumber,
      currentRallyOrdinal: rallyOrdinal,
    })
  })
  const vectorMemberships = memberships.filter(membership => membership.tracklet.vectors.length > 0)
  const vectorClusterIds = new Set(vectorMemberships.map(membership => membership.personClusterId))
  const bankClusters = clusters.filter(cluster => vectorClusterIds.has(cluster.id))
  const historicalTrackletIds = [...new Set(vectorMemberships.map(item => item.trackletId))]
  const cannotLinks = historicalTrackletIds.length
    ? await database.reidCannotLink.findMany({
        where: {
          matchId,
          leftTrackletId: { in: historicalTrackletIds },
          rightTrackletId: { in: historicalTrackletIds },
        },
      })
    : []
  const artifactsById = new Map<
    string,
    (typeof vectorMemberships)[number]['tracklet']['evidenceSet']['descriptorBundleAsset']
  >()
  const vectorsById = new Map<
    string,
    (typeof vectorMemberships)[number]['tracklet']['vectors'][number]
  >()
  for (const membership of vectorMemberships) {
    const asset = membership.tracklet.evidenceSet.descriptorBundleAsset
    artifactsById.set(asset.id, asset)
    for (const vector of membership.tracklet.vectors) vectorsById.set(vector.id, vector)
  }
  const revision = resolveReidBankRevision(
    vectorMemberships,
    bankClusters.flatMap(cluster =>
      cluster.bindingRevisions.map(binding => ({
        personClusterId: cluster.id,
        revision: binding.revision,
      })),
    ),
  )
  const existingSnapshot = await database.reidBankSnapshot.findUnique({
    where: {
      matchId_teamId_revision_asOfSetNumber_asOfRallyOrdinal_derivationVersion: {
        matchId,
        teamId,
        revision,
        asOfSetNumber: setNumber,
        asOfRallyOrdinal: rallyOrdinal,
        derivationVersion: REID_BANK_DERIVATION_VERSION,
      },
    },
    include: { manifestAsset: true },
  })
  const snapshotId = existingSnapshot?.id ?? randomUUID()
  const bank = buildReidBankSnapshot({
    snapshotId,
    matchId,
    teamId,
    revision,
    setNumber,
    rallyOrdinal,
    clusters: bankClusters.map(cluster => ({
      personClusterId: cluster.id,
      rosterEntryId:
        cluster.bindingRevisions.length > 0
          ? cluster.bindingRevisions[0]!.rosterEntryId
          : cluster.canonicalRosterEntryId,
    })),
    artifacts: [...artifactsById.values()].map(asset => {
      if (asset.sha256 === null || asset.byteLength === null)
        throw new ReidAssociationMaterializationError(
          'historical descriptor asset is not ready',
          true,
        )
      return { artifactId: asset.id, sha256: asset.sha256, byteLength: asset.byteLength }
    }),
    vectors: [...vectorsById.values()].map(vector => {
      const membership = vectorMemberships.find(item =>
        item.tracklet.vectors.some(candidate => candidate.id === vector.id),
      )!
      return {
        vectorId: vector.id,
        artifactId: membership.tracklet.evidenceSet.descriptorBundleAssetId,
        modality: vector.modality,
        modelNamespace: vector.modelNamespace,
        dimension: vector.dimension,
        normalization: vector.normalization,
        distance: vector.distance,
        byteOffset: vector.byteOffset,
        byteLength: vector.byteLength,
        sha256: vector.sha256,
      }
    }),
    memberships: vectorMemberships.map(membership => ({
      membershipId: membership.id,
      personClusterId: membership.personClusterId,
      trackletId: membership.trackletId,
      vectorIds: membership.tracklet.vectors.map(vector => vector.id),
      evidenceRole: membership.evidenceRole,
      weight: membership.weight,
      sourceRevision: membership.sourceRevision,
      rosterEntryId: membership.rosterEntryId,
    })),
    cannotLinks: cannotLinks.map(link => ({
      leftTrackletId: link.leftTrackletId,
      rightTrackletId: link.rightTrackletId,
      reason: link.reason,
    })),
  })
  if (!validateBankSnapshot(bank))
    throw new ReidAssociationMaterializationError('generated ReID bank snapshot is invalid', false)
  if (existingSnapshot && existingSnapshot.contentSha256 !== bank.content_sha256)
    throw new ReidAssociationMaterializationError(
      `existing ReID bank revision ${revision} does not match current eligible evidence ` +
        `(stored=${existingSnapshot.contentSha256}, generated=${bank.content_sha256})`,
      false,
    )
  const bankBytes = Buffer.from(`${canonicalJson(bank)}\n`, 'utf8')
  const objectKey =
    existingSnapshot?.manifestAsset.objectKey ?? `reid/banks/${bank.content_sha256}.json`
  const upload = existingSnapshot
    ? {
        byteLength: existingSnapshot.manifestAsset.byteLength,
        sha256: existingSnapshot.manifestAsset.sha256,
      }
    : await putVerifiedBuffer(
        storage.client,
        storage.analysisBucket,
        objectKey,
        bankBytes,
        'application/vnd.volleyball.reid-bank-snapshot+json;version=1.1',
        {
          'x-amz-meta-artifact-kind': 'REID_BANK_SNAPSHOT',
          'x-amz-meta-internal-schema-version': '1.1.0',
        },
      )
  if (upload.byteLength === null || upload.sha256 === null)
    throw new ReidAssociationMaterializationError('existing ReID bank artifact is not ready', true)
  const providerJobId = randomUUID()
  const associationRunId = randomUUID()
  const idempotencyKey = reidAssociationIdempotencyKey({
    evidenceSetId: evidenceSet.id,
    teamId,
    bankContentSha256: bank.content_sha256,
    rerunRequestId: rerunRequest?.id ?? null,
  })
  return database.$transaction(async tx => {
    if (await tx.providerJob.findUnique({ where: { idempotencyKey } })) return false
    const manifestAsset = existingSnapshot
      ? await tx.mediaAsset.findUniqueOrThrow({ where: { id: existingSnapshot.manifestAssetId } })
      : await tx.mediaAsset.upsert({
          where: { bucket_objectKey: { bucket: storage.analysisBucket, objectKey } },
          update: {},
          create: {
            kind: MediaAssetKind.REID_EVIDENCE,
            bucket: storage.analysisBucket,
            objectKey,
            contentType: 'application/vnd.volleyball.reid-bank-snapshot+json;version=1.1',
            byteLength: upload.byteLength,
            sha256: upload.sha256,
            internalSchemaVersion: '1.1.0',
            state: ArtifactState.READY,
            readyAt: new Date(),
          },
        })
    const evidenceResultInput = {
      id: randomUUID(),
      asset: evidenceSet.resultAsset,
      kind: 'REID_FEATURE_RESULT',
      version: '2.0.0',
    }
    const bankSnapshotInput = {
      id: randomUUID(),
      asset: manifestAsset,
      kind: 'REID_BANK_SNAPSHOT',
      version: '1.1.0',
    }
    const rosterSnapshotInput = {
      id: randomUUID(),
      asset: rosterArtifact,
      kind: 'REID_ROSTER_SNAPSHOT',
      version: '1.0.0',
    }
    const inputs = [
      evidenceResultInput,
      {
        id: randomUUID(),
        asset: evidenceSet.descriptorBundleAsset,
        kind: 'REID_DESCRIPTOR_BUNDLE',
        version: '1.0.0',
      },
      bankSnapshotInput,
      rosterSnapshotInput,
      ...[...artifactsById.values()].map(asset => ({
        id: randomUUID(),
        asset,
        kind: 'REID_DESCRIPTOR_BUNDLE',
        version: '1.0.0',
      })),
    ]
    const request = {
      schema_version: '2.0.0',
      provider_job_id: providerJobId,
      association_run_id: associationRunId,
      match_id: matchId,
      evidence_set_id: evidenceSet.id,
      eligible_tracklet_ids: eligibleTrackletIds,
      evidence_result_artifact_id: evidenceResultInput.id,
      bank_snapshot_id: snapshotId,
      bank_snapshot_artifact_id: bankSnapshotInput.id,
      roster_snapshot_artifact_id: rosterSnapshotInput.id,
      recipe: {
        namespace: ASSOCIATION_RECIPE,
        candidate_modalities: ['DINO', 'OSNET', 'KPR_PROMPT'],
        same_clip_grouping: true,
        allow_new_gid: true,
        manual_assignment_precedence: true,
        team_occupancy_prior: {
          expected_count: 6,
          enforcement: 'SOFT',
        },
      },
    }
    if (!validateAssociationRequest(request))
      throw new ReidAssociationMaterializationError(
        'generated ReID association request is invalid',
        false,
      )
    if (
      inputs.some(
        input =>
          input.asset.state !== ArtifactState.READY ||
          input.asset.sha256 === null ||
          input.asset.byteLength === null,
      )
    )
      throw new ReidAssociationMaterializationError('association input is not ready', true)
    const token = randomBytes(32).toString('base64url')
    if (!existingSnapshot)
      await tx.reidBankSnapshot.create({
        data: {
          id: snapshotId,
          matchId,
          teamId,
          revision,
          asOfSetNumber: setNumber,
          asOfRallyOrdinal: rallyOrdinal,
          schemaVersion: '1.1.0',
          derivationVersion: REID_BANK_DERIVATION_VERSION,
          manifestAssetId: manifestAsset.id,
          contentSha256: bank.content_sha256,
        },
      })
    await tx.providerJob.create({
      data: {
        id: providerJobId,
        workKind: ProviderWorkKind.REID_ASSOCIATION,
        idempotencyKey,
        requestSchemaVersion: '2.0.0',
        resultSchemaVersion: '2.0.0',
        requestPayload: json(request),
        requestPayloadHash: sha256Hex(canonicalJson(request)),
        callbackTokenHash: sha256Hex(token),
        callbackTokenExpiresAt: new Date(Date.now() + 30 * 60_000),
        analysisRunId: evidenceSet.analysisRunId,
        parentProviderJobId: evidenceSet.providerJobId,
        stage: 'association_queued',
        artifacts: {
          create: inputs.map((input, ordinal) => ({
            id: input.id,
            mediaAssetId: input.asset.id,
            direction: ProviderArtifactDirection.INPUT,
            artifactKind: input.kind,
            ordinal,
            required: true,
            schemaVersion: input.version,
            sha256: input.asset.sha256!,
            byteLength: input.asset.byteLength!,
            contentType: input.asset.contentType,
          })),
        },
      },
    })
    await tx.reidAssociationRun.create({
      data: {
        id: associationRunId,
        evidenceSetId: evidenceSet.id,
        bankSnapshotId: snapshotId,
        providerJobId,
        schemaVersion: '2.0.0',
        status: JobStatus.QUEUED,
        shadowOnly: false,
        rerunRequestId: rerunRequest?.id ?? null,
      },
    })
    if (rerunRequest)
      await tx.reidAssociationRerunRequest.updateMany({
        where: { id: rerunRequest.id, status: JobStatus.QUEUED },
        data: { status: JobStatus.RUNNING, startedAt: new Date(), errorMessage: null },
      })
    return true
  })
}

export async function materializeReidAssociationResult(
  database: PrismaClient,
  storage: WorkflowMinio,
  providerJob: {
    id: string
    requestPayload: Prisma.JsonValue
    artifacts: AssociationArtifact[]
  },
) {
  const request = isRecord(providerJob.requestPayload) ? providerJob.requestPayload : null
  if (!request)
    throw new ReidAssociationMaterializationError('association provider request is invalid', false)
  const artifact = oneArtifact(providerJob.artifacts, 'REID_ASSOCIATION_RESULT')
  const result = await readJsonArtifact(storage, artifact)
  if (!validateAssociationResult(result))
    throw new ReidAssociationMaterializationError(
      'association result failed schema validation',
      false,
    )
  try {
    verifiedSemanticContentSha(result, 'ReID association result')
  } catch (error) {
    materializationError(error)
  }
  for (const [key, expected] of Object.entries({
    provider_job_id: providerJob.id,
    association_run_id: request.association_run_id,
    evidence_set_id: request.evidence_set_id,
    bank_snapshot_id: request.bank_snapshot_id,
  }))
    if (result[key] !== expected)
      throw new ReidAssociationMaterializationError(
        `association ${key} passthrough mismatch`,
        false,
      )
  const { eligible, decisions } = planReidAssociationDecisions(request, result)
  const runContext = await database.reidAssociationRun.findUnique({
    where: { providerJobId: providerJob.id },
    include: {
      bankSnapshot: { include: { manifestAsset: true } },
      evidenceSet: { select: { analysisRunId: true } },
    },
  })
  if (
    !runContext ||
    runContext.id !== request.association_run_id ||
    runContext.evidenceSetId !== request.evidence_set_id ||
    runContext.bankSnapshotId !== request.bank_snapshot_id
  )
    throw new ReidAssociationMaterializationError(
      'association run does not match the immutable request',
      false,
    )
  const currentBankRevision = await latestApplicableBankRevision(
    database,
    runContext.bankSnapshot.matchId,
    runContext.bankSnapshot.teamId,
    runContext.bankSnapshot.asOfSetNumber,
    runContext.bankSnapshot.asOfRallyOrdinal,
  )
  const isCurrentBankRevision = runContext.bankSnapshot.revision === currentBankRevision
  const bank = await readJsonArtifact(storage, {
    artifactKind: 'REID_BANK_SNAPSHOT',
    sha256: runContext.bankSnapshot.contentSha256,
    byteLength: runContext.bankSnapshot.manifestAsset.byteLength ?? 0n,
    mediaAsset: runContext.bankSnapshot.manifestAsset,
  })
  if (!validateBankSnapshot(bank))
    throw new ReidAssociationMaterializationError(
      'association bank snapshot failed schema validation',
      false,
    )
  try {
    verifiedSemanticContentSha(bank, 'ReID bank snapshot')
  } catch (error) {
    materializationError(error)
  }
  if (
    bank.bank_snapshot_id !== runContext.bankSnapshot.id ||
    bank.content_sha256 !== runContext.bankSnapshot.contentSha256
  )
    throw new ReidAssociationMaterializationError(
      'association bank snapshot does not match its database record',
      false,
    )
  const bankClusters = new Map(
    records(bank.clusters).map(cluster => [cluster.person_cluster_id, cluster.roster_entry_id]),
  )
  for (const decision of decisions) {
    const candidateRows = records(decision.candidates)
    const selected = candidateRows.find(
      candidate => candidate.person_cluster_id === decision.selected_person_cluster_id,
    )
    for (const candidate of candidateRows) {
      if (
        typeof candidate.person_cluster_id === 'string' &&
        (!bankClusters.has(candidate.person_cluster_id) ||
          bankClusters.get(candidate.person_cluster_id) !== candidate.roster_entry_id)
      )
        throw new ReidAssociationMaterializationError(
          'association candidate is outside the immutable bank snapshot',
          false,
        )
    }
    if (
      decision.action === 'MATCH_EXISTING_GID' &&
      (!selected || selected.roster_entry_id !== decision.selected_roster_entry_id)
    )
      throw new ReidAssociationMaterializationError(
        'existing-GID association must select a candidate from the immutable bank snapshot',
        false,
      )
  }
  const [eligibleTracklets, clusterCount, rosterCount, activeTeamGids] = await Promise.all([
    database.reidTracklet.findMany({
      where: { id: { in: [...eligible] } },
      select: {
        id: true,
        firstFrameIndex: true,
        lastFrameIndex: true,
        cannotLinkTrackletIds: true,
      },
    }),
    database.reidPersonCluster.count({
      where: {
        id: {
          in: decisions
            .map(decision => decision.selected_person_cluster_id)
            .filter((value): value is string => typeof value === 'string'),
        },
      },
    }),
    database.matchRosterEntry.count({
      where: {
        id: {
          in: decisions
            .map(decision => decision.selected_roster_entry_id)
            .filter((value): value is string => typeof value === 'string'),
        },
      },
    }),
    database.reidPersonCluster.findMany({
      where: {
        matchId: runContext.bankSnapshot.matchId,
        teamId: runContext.bankSnapshot.teamId,
        supersededRevision: null,
      },
      select: {
        id: true,
        canonicalRosterEntryId: true,
        createdAt: true,
        assignmentRevisions: {
          where: {
            analysisRunId: runContext.evidenceSet.analysisRunId,
            activeProjection: { is: { analysisRunId: runContext.evidenceSet.analysisRunId } },
          },
          select: { sourcePriority: true },
          take: 1,
        },
        memberships: {
          where: {
            evidenceState: ReidEvidenceState.CONFIRMED,
            supersededByMemberships: { none: {} },
          },
          select: { id: true },
          take: 1,
        },
        bindingRevisions: {
          where: {
            OR: [
              { effectiveFromSetNumber: { lt: runContext.bankSnapshot.asOfSetNumber } },
              {
                effectiveFromSetNumber: runContext.bankSnapshot.asOfSetNumber,
                effectiveFromRallyOrdinal: {
                  lte: runContext.bankSnapshot.asOfRallyOrdinal,
                },
              },
            ],
          },
          orderBy: [
            { effectiveFromSetNumber: 'desc' },
            { effectiveFromRallyOrdinal: 'desc' },
            { revision: 'desc' },
          ],
          select: { rosterEntryId: true, source: true },
          take: 1,
        },
      },
    }),
  ])
  const selectedClusters = new Set(
    decisions
      .map(decision => decision.selected_person_cluster_id)
      .filter((value): value is string => typeof value === 'string'),
  )
  const selectedRoster = new Set(
    decisions
      .map(decision => decision.selected_roster_entry_id)
      .filter((value): value is string => typeof value === 'string'),
  )
  if (
    eligibleTracklets.length !== eligible.size ||
    clusterCount !== selectedClusters.size ||
    rosterCount !== selectedRoster.size
  )
    throw new ReidAssociationMaterializationError(
      'association result references unknown database rows',
      false,
    )
  const orderedTeamGids = activeTeamGids
    .map(gid => ({
      ...gid,
      rosterEntryId: gid.bindingRevisions[0]?.rosterEntryId ?? gid.canonicalRosterEntryId,
      currentPriority: gid.assignmentRevisions[0]?.sourcePriority ?? -1,
      manuallyGrounded:
        gid.memberships.length > 0 ||
        gid.canonicalRosterEntryId !== null ||
        gid.bindingRevisions[0]?.source === IdentitySource.MANUAL,
    }))
    .sort((left, right) => {
      const leftCurrentManual = left.currentPriority >= 1_000
      const rightCurrentManual = right.currentPriority >= 1_000
      if (leftCurrentManual !== rightCurrentManual) return leftCurrentManual ? -1 : 1
      const leftCurrent = left.currentPriority >= 0
      const rightCurrent = right.currentPriority >= 0
      if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1
      if (left.manuallyGrounded !== right.manuallyGrounded) return left.manuallyGrounded ? -1 : 1
      const created = left.createdAt.getTime() - right.createdAt.getTime()
      return created || left.id.localeCompare(right.id)
    })
  const gidPolicy = planCappedGidResolutions({
    decisions: decisions as CappedGidDecision[],
    tracklets: eligibleTracklets,
    existingGids: orderedTeamGids.map(gid => ({
      id: gid.id,
      rosterEntryId: gid.rosterEntryId,
    })),
  })
  return database.$transaction(async tx => {
    const run = await tx.reidAssociationRun.findUnique({
      where: { providerJobId: providerJob.id },
      include: {
        bankSnapshot: { select: { teamId: true } },
        evidenceSet: {
          include: {
            tracklets: { select: { id: true, canonicalTrackId: true, courtSide: true } },
            analysisRun: {
              include: {
                submission: { include: { rally: { include: { set: true } } } },
              },
            },
          },
        },
      },
    })
    if (!run) throw new ReidAssociationMaterializationError('association run is missing', false)
    if (run.completedAt) return run.id
    const createdClusterByGroup = new Map<string, string>()
    if (!run.shadowOnly && isCurrentBankRevision) {
      const submission = run.evidenceSet.analysisRun.submission
      const matchId = submission.rally.matchId
      await tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${matchId}::uuid FOR UPDATE`
      let revision = (
        await tx.match.findUniqueOrThrow({
          where: { id: matchId },
          select: { identityRevision: true },
        })
      ).identityRevision
      const tracklets = new Map(run.evidenceSet.tracklets.map(tracklet => [tracklet.id, tracklet]))
      for (const decision of decisions) {
        const tracklet = tracklets.get(String(decision.tracklet_id))
        if (!tracklet) continue
        const resolution = gidPolicy.resolutions.get(tracklet.id)
        if (!resolution)
          throw new ReidAssociationMaterializationError(
            'capped GID policy did not resolve an eligible tracklet',
            false,
          )
        const active = await tx.reidActiveProjection.findFirst({
          where: {
            analysisRunId: run.evidenceSet.analysisRunId,
            OR: [
              { trackletId: tracklet.id },
              { tracklet: { canonicalTrackId: tracklet.canonicalTrackId } },
            ],
          },
          include: { assignmentRevision: true },
          orderBy: [{ sourcePriority: 'desc' }, { updatedAt: 'desc' }],
        })
        if (active && active.sourcePriority >= 1_000) continue
        revision += 1n
        let personClusterId: string
        const rosterEntryId = resolution.rosterEntryId
        if (resolution.createGroupKey === null) {
          personClusterId = resolution.personClusterKey
        } else {
          const groupKey = resolution.createGroupKey
          const existingCreatedId = createdClusterByGroup.get(groupKey)
          personClusterId = existingCreatedId ?? randomUUID()
          if (!existingCreatedId) {
            createdClusterByGroup.set(groupKey, personClusterId)
            await tx.reidPersonCluster.create({
              data: {
                id: personClusterId,
                matchId,
                teamId: run.bankSnapshot.teamId,
                canonicalRosterEntryId: null,
                label: `GID ${personClusterId.slice(0, 8)}`,
                createdRevision: revision,
              },
            })
            await tx.reidGidRosterBindingRevision.create({
              data: {
                matchId,
                personClusterId,
                rosterEntryId: null,
                source: IdentitySource.AI,
                revision,
                effectiveFromSetNumber: submission.rally.displaySetNumber,
                effectiveFromRallyOrdinal: submission.rally.ordinal,
              },
            })
          }
        }
        const priorMembership = await tx.reidEvidenceMembership.findFirst({
          where: {
            trackletId: tracklet.id,
            supersededByMemberships: { none: {} },
          },
          orderBy: [{ sourceRevision: 'desc' }, { createdAt: 'desc' }],
        })
        await tx.reidEvidenceMembership.create({
          data: {
            personClusterId,
            trackletId: tracklet.id,
            rosterEntryId,
            evidenceState: ReidEvidenceState.UNVERIFIED,
            evidenceRole: ReidEvidenceRole.POSITIVE,
            weight: Math.max(0.35, Math.min(0.75, 0.35 + resolution.confidence * 0.4)),
            sourceRevision: revision,
            supersedesMembershipId: priorMembership?.id ?? null,
          },
        })
        const assignment = await tx.reidAssignmentRevision.create({
          data: {
            matchId,
            analysisRunId: run.evidenceSet.analysisRunId,
            trackletId: tracklet.id,
            personClusterId,
            rosterEntryId,
            source: IdentitySource.AI,
            sourcePriority: 100,
            revision,
            effectiveFromSetNumber: submission.rally.displaySetNumber,
            effectiveFromRallyOrdinal: submission.rally.ordinal,
            supersedesRevisionId: active?.assignmentRevisionId ?? null,
          },
        })
        await tx.reidActiveProjection.upsert({
          where: { trackletId: tracklet.id },
          update: {
            analysisRunId: run.evidenceSet.analysisRunId,
            assignmentRevisionId: assignment.id,
            sourcePriority: 100,
          },
          create: {
            analysisRunId: run.evidenceSet.analysisRunId,
            trackletId: tracklet.id,
            assignmentRevisionId: assignment.id,
            sourcePriority: 100,
          },
        })
        if (assignment.rosterEntryId) {
          await tx.trackIdentityAssignment.upsert({
            where: {
              analysisRunId_trackId: {
                analysisRunId: run.evidenceSet.analysisRunId,
                trackId: tracklet.canonicalTrackId,
              },
            },
            update: {
              rosterEntryId: assignment.rosterEntryId,
              source: IdentitySource.AI,
              assignedByUserId: null,
              confidence: resolution.confidence,
              identityRevision: revision,
            },
            create: {
              analysisRunId: run.evidenceSet.analysisRunId,
              trackId: tracklet.canonicalTrackId,
              rosterEntryId: assignment.rosterEntryId,
              source: IdentitySource.AI,
              confidence: resolution.confidence,
              identityRevision: revision,
            },
          })
        } else
          await tx.trackIdentityAssignment.deleteMany({
            where: {
              analysisRunId: run.evidenceSet.analysisRunId,
              trackId: tracklet.canonicalTrackId,
              source: IdentitySource.AI,
            },
          })
      }
      await tx.match.update({ where: { id: matchId }, data: { identityRevision: revision } })
    }
    for (const decision of decisions) {
      const resolution = gidPolicy.resolutions.get(String(decision.tracklet_id))
      if (!resolution)
        throw new ReidAssociationMaterializationError(
          'capped GID policy did not resolve an association decision',
          false,
        )
      await tx.reidAssociationDecision.create({
        data: {
          associationRunId: run.id,
          trackletId: String(decision.tracklet_id),
          groupKey: String(decision.group_key),
          decisionAction:
            resolution.createGroupKey === null ? 'MATCH_EXISTING_GID' : 'CREATE_NEW_GID',
          newGidGroupKey: resolution.createGroupKey,
          associationState: ReidAssociationState.RESOLVED,
          selectedPersonClusterId:
            resolution.createGroupKey === null
              ? resolution.personClusterKey
              : (createdClusterByGroup.get(resolution.createGroupKey) ?? null),
          selectedRosterEntryId: resolution.rosterEntryId,
          confidence: resolution.confidence,
          candidates: json(decision.candidates),
          rationale:
            resolution.providerAction === decision.action &&
            (decision.action !== 'CREATE_NEW_GID' || resolution.createGroupKey !== null)
              ? String(decision.rationale)
              : `[central capped-GID policy; provider=${String(decision.action)}] ${String(decision.rationale)}`,
          unresolvedReason: null,
        },
      })
    }
    await tx.reidAssociationRun.update({
      where: { id: run.id },
      data: {
        status: JobStatus.COMPLETED,
        resultAssetId: artifact.mediaAsset.id,
        contentSha256: String(result.content_sha256).toLowerCase(),
        completedAt: new Date(),
      },
    })
    if (run.rerunRequestId) {
      const submission = run.evidenceSet.analysisRun.submission
      const expectedTeamIds = new Set<string>()
      if (run.evidenceSet.tracklets.some(row => row.courtSide === TrackCourtSide.LEFT))
        expectedTeamIds.add(submission.leftTeamId)
      if (run.evidenceSet.tracklets.some(row => row.courtSide === TrackCourtSide.RIGHT))
        expectedTeamIds.add(submission.rightTeamId)
      const completedRuns = await tx.reidAssociationRun.findMany({
        where: { rerunRequestId: run.rerunRequestId, status: JobStatus.COMPLETED },
        select: { bankSnapshot: { select: { teamId: true } } },
      })
      const completedTeamIds = new Set(completedRuns.map(row => row.bankSnapshot.teamId))
      if ([...expectedTeamIds].every(teamId => completedTeamIds.has(teamId)))
        await tx.reidAssociationRerunRequest.update({
          where: { id: run.rerunRequestId },
          data: { status: JobStatus.COMPLETED, completedAt: new Date(), errorMessage: null },
        })
    }
    if (isCurrentBankRevision) {
      const supersededAt = new Date()
      await tx.reidAssociationRun.updateMany({
        where: {
          id: { not: run.id },
          evidenceSetId: run.evidenceSetId,
          completedAt: { not: null },
          supersededAt: null,
          bankSnapshot: {
            teamId: runContext.bankSnapshot.teamId,
            revision: { lt: runContext.bankSnapshot.revision },
          },
        },
        data: { supersededAt, supersededByRunId: run.id },
      })
    }
    await tx.providerJob.update({
      where: { id: providerJob.id },
      data: { stage: 'materialized', leasedUntil: null, errorCode: null, errorMessage: null },
    })
    return run.id
  })
}

export function createReidAssociationWorker(
  database: PrismaClient,
  options: {
    idleMs?: number
    disconnectOnStop?: boolean
    onError?: (error: unknown) => void
    now?: () => Date
    storage?: WorkflowMinio
  } = {},
) {
  const storage = options.storage ?? createWorkflowMinio()
  const now = options.now ?? (() => new Date())
  async function processNext(): Promise<boolean> {
    const currentTime = now()
    const candidate = await database.providerJob.findFirst({
      where: {
        workKind: ProviderWorkKind.REID_ASSOCIATION,
        status: JobStatus.COMPLETED,
        OR: [
          { stage: 'completed' },
          { stage: 'association_materializing', leasedUntil: { lt: currentTime } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      include: {
        artifacts: {
          where: { direction: ProviderArtifactDirection.OUTPUT },
          include: { mediaAsset: true },
          orderBy: { ordinal: 'asc' },
        },
      },
    })
    if (!candidate) return scheduleReidAssociation(database, storage)
    const claimed = await database.providerJob.updateMany({
      where: {
        id: candidate.id,
        status: JobStatus.COMPLETED,
        OR: [
          { stage: 'completed' },
          { stage: 'association_materializing', leasedUntil: { lt: currentTime } },
        ],
      },
      data: {
        stage: 'association_materializing',
        leasedUntil: new Date(currentTime.getTime() + ASSOCIATION_LEASE_MS),
        errorCode: null,
        errorMessage: null,
      },
    })
    if (claimed.count !== 1) return false
    try {
      await materializeReidAssociationResult(database, storage, candidate)
    } catch (error) {
      const terminal = error instanceof ReidAssociationMaterializationError && !error.retryable
      await database.providerJob.update({
        where: { id: candidate.id },
        data: {
          stage: terminal ? 'association_materialization_failed' : 'completed',
          leasedUntil: null,
          availableAt: new Date(now().getTime() + (terminal ? 0 : 30_000)),
          errorCode: terminal
            ? 'INVALID_REID_ASSOCIATION_ARTIFACT'
            : 'REID_ASSOCIATION_MATERIALIZATION_RETRY',
          errorMessage: (error instanceof Error
            ? error.message
            : 'unknown association materialization failure'
          ).slice(0, 1_000),
        },
      })
      if (terminal)
        await database.reidAssociationRerunRequest.updateMany({
          where: {
            status: JobStatus.RUNNING,
            associationRuns: { some: { providerJobId: candidate.id } },
          },
          data: {
            status: JobStatus.FAILED,
            completedAt: new Date(),
            errorMessage: (error instanceof Error
              ? error.message
              : 'unknown association materialization failure'
            ).slice(0, 1_000),
          },
        })
    }
    return true
  }
  return createPollingLifecycle(processNext, {
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
    onError: error => {
      console.error(
        'reid-association-worker loop error',
        error instanceof Error ? error.name : 'UnknownError',
      )
      options.onError?.(error)
    },
    ...(options.disconnectOnStop === false ? {} : { disconnect: () => database.$disconnect() }),
  })
}
