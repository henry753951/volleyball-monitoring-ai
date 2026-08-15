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
  rerunRequestId?: string | null
  bankSnapshot: { teamId: string; revision: bigint }
}

export function hasReidAssociationRevision(
  runs: AssociationRevisionRun[],
  teamId: string,
  revision: bigint,
) {
  return runs.some(
    run => run.bankSnapshot.teamId === teamId && run.bankSnapshot.revision === revision,
  )
}

export function hasReidAssociationRerun(
  runs: AssociationRevisionRun[],
  teamId: string,
  rerunRequestId: string,
) {
  return runs.some(
    run => run.rerunRequestId === rerunRequestId && run.bankSnapshot.teamId === teamId,
  )
}

async function latestApplicableBankRevision(
  database: PrismaClient,
  matchId: string,
  teamId: string,
  setNumber: number,
  rallyOrdinal: number,
) {
  const memberships = await database.reidEvidenceMembership.findMany({
    where: {
      evidenceState: ReidEvidenceState.CONFIRMED,
      personCluster: { matchId, teamId, supersededRevision: null },
      supersededByMemberships: { none: {} },
      tracklet: {
        evidenceSet: {
          analysisRun: {
            submission: {
              rally: {
                matchId,
                OR: [
                  { displaySetNumber: { lt: setNumber } },
                  { displaySetNumber: setNumber, ordinal: { lt: rallyOrdinal } },
                ],
              },
            },
          },
        },
      },
    },
    select: { sourceRevision: true },
  })
  return memberships.reduce(
    (maximum, membership) =>
      membership.sourceRevision > maximum ? membership.sourceRevision : maximum,
    0n,
  )
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
  const rerunRequest = await database.reidAssociationRerunRequest.findFirst({
    where: { status: { in: [JobStatus.QUEUED, JobStatus.RUNNING] } },
    orderBy: { createdAt: 'asc' },
  })
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
      tracklets: { select: { id: true, courtSide: true } },
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
        .filter(tracklet => tracklet.courtSide === candidate.side)
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
  if (!selected) return false

  const { evidenceSet, teamId, eligibleTrackletIds } = selected
  const submission = evidenceSet.analysisRun.submission
  const matchId = submission.rally.matchId
  const setNumber = submission.rally.displaySetNumber
  const rallyOrdinal = submission.rally.ordinal
  const rosterArtifact = evidenceSet.providerJob.artifacts[0]?.mediaAsset
  if (!rosterArtifact || rosterArtifact.state !== ArtifactState.READY)
    throw new ReidAssociationMaterializationError('immutable roster snapshot is unavailable', true)

  const rosterEntries = await database.matchRosterEntry.findMany({ where: { matchId, teamId } })
  for (const entry of rosterEntries)
    await database.reidPersonCluster.upsert({
      where: { canonicalRosterEntryId: entry.id },
      update: {},
      create: {
        matchId,
        teamId,
        canonicalRosterEntryId: entry.id,
        label: entry.displayNameSnapshot ?? `#${entry.jerseyNumber}`,
        createdRevision: 0n,
      },
    })
  const clusters = await database.reidPersonCluster.findMany({
    where: { matchId, teamId, supersededRevision: null },
  })
  const memberships = (
    await database.reidEvidenceMembership.findMany({
      where: {
        evidenceState: ReidEvidenceState.CONFIRMED,
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
    return beforePosition(prior.displaySetNumber, prior.ordinal, setNumber, rallyOrdinal)
  })
  const vectorMemberships = memberships.filter(membership => membership.tracklet.vectors.length > 0)
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
  const revision = memberships.reduce(
    (maximum, membership) =>
      membership.sourceRevision > maximum ? membership.sourceRevision : maximum,
    0n,
  )
  const existingSnapshot = await database.reidBankSnapshot.findUnique({
    where: {
      matchId_teamId_revision_asOfSetNumber_asOfRallyOrdinal: {
        matchId,
        teamId,
        revision,
        asOfSetNumber: setNumber,
        asOfRallyOrdinal: rallyOrdinal,
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
    clusters: clusters.map(cluster => ({
      personClusterId: cluster.id,
      rosterEntryId: cluster.canonicalRosterEntryId,
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
      'existing ReID bank revision does not match current eligible evidence',
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
  const idempotencyKey = rerunRequest
    ? `reid-association:${evidenceSet.id}:${teamId}:${bank.content_sha256}:rerun:${rerunRequest.id}`
    : `reid-association:${evidenceSet.id}:${teamId}:${bank.content_sha256}`
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
    const request = {
      schema_version: '1.1.0',
      provider_job_id: providerJobId,
      association_run_id: associationRunId,
      match_id: matchId,
      evidence_set_id: evidenceSet.id,
      eligible_tracklet_ids: eligibleTrackletIds,
      evidence_result_artifact_id: evidenceSet.resultAssetId,
      bank_snapshot_id: snapshotId,
      bank_snapshot_artifact_id: manifestAsset.id,
      roster_snapshot_artifact_id: rosterArtifact.id,
      recipe: {
        namespace: ASSOCIATION_RECIPE,
        candidate_modalities: ['DINO', 'OSNET', 'KPR_PROMPT', 'JERSEY_VLM'],
        same_clip_grouping: true,
        allow_abstention: true,
        manual_assignment_precedence: true,
      },
    }
    if (!validateAssociationRequest(request))
      throw new ReidAssociationMaterializationError(
        'generated ReID association request is invalid',
        false,
      )
    const inputs = [
      { asset: evidenceSet.resultAsset, kind: 'REID_FEATURE_RESULT', version: '1.0.0' },
      {
        asset: evidenceSet.descriptorBundleAsset,
        kind: 'REID_DESCRIPTOR_BUNDLE',
        version: '1.0.0',
      },
      { asset: manifestAsset, kind: 'REID_BANK_SNAPSHOT', version: '1.1.0' },
      { asset: rosterArtifact, kind: 'REID_ROSTER_SNAPSHOT', version: '1.0.0' },
      ...[...artifactsById.values()].map(asset => ({
        asset,
        kind: 'REID_DESCRIPTOR_BUNDLE',
        version: '1.0.0',
      })),
    ]
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
          manifestAssetId: manifestAsset.id,
          contentSha256: bank.content_sha256,
        },
      })
    await tx.providerJob.create({
      data: {
        id: providerJobId,
        workKind: ProviderWorkKind.REID_ASSOCIATION,
        idempotencyKey,
        requestSchemaVersion: '1.1.0',
        resultSchemaVersion: '1.0.0',
        requestPayload: json(request),
        requestPayloadHash: sha256Hex(canonicalJson(request)),
        callbackTokenHash: sha256Hex(token),
        callbackTokenExpiresAt: new Date(Date.now() + 30 * 60_000),
        analysisRunId: evidenceSet.analysisRunId,
        parentProviderJobId: evidenceSet.providerJobId,
        stage: 'association_queued',
        artifacts: {
          create: inputs.map((input, ordinal) => ({
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
        schemaVersion: '1.0.0',
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
    include: { bankSnapshot: { include: { manifestAsset: true } } },
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
      decision.association_state === ReidAssociationState.RESOLVED &&
      (!selected || selected.roster_entry_id !== decision.selected_roster_entry_id)
    )
      throw new ReidAssociationMaterializationError(
        'resolved association must select a candidate from the immutable bank snapshot',
        false,
      )
  }
  const [trackletCount, clusterCount, rosterCount] = await Promise.all([
    database.reidTracklet.count({ where: { id: { in: [...eligible] } } }),
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
    trackletCount !== eligible.size ||
    clusterCount !== selectedClusters.size ||
    rosterCount !== selectedRoster.size
  )
    throw new ReidAssociationMaterializationError(
      'association result references unknown database rows',
      false,
    )
  return database.$transaction(async tx => {
    const run = await tx.reidAssociationRun.findUnique({
      where: { providerJobId: providerJob.id },
      include: {
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
    for (const decision of decisions) {
      const candidateRows = records(decision.candidates)
      const selectedCandidate = candidateRows.find(
        candidate => candidate.person_cluster_id === decision.selected_person_cluster_id,
      )
      await tx.reidAssociationDecision.create({
        data: {
          associationRunId: run.id,
          trackletId: String(decision.tracklet_id),
          groupKey: String(decision.group_key),
          associationState: String(decision.association_state) as ReidAssociationState,
          selectedPersonClusterId:
            typeof decision.selected_person_cluster_id === 'string'
              ? decision.selected_person_cluster_id
              : null,
          selectedRosterEntryId:
            typeof decision.selected_roster_entry_id === 'string'
              ? decision.selected_roster_entry_id
              : null,
          confidence:
            selectedCandidate && typeof selectedCandidate.confidence === 'number'
              ? selectedCandidate.confidence
              : null,
          candidates: json(decision.candidates),
          unresolvedReason:
            typeof decision.unresolved_reason === 'string' ? decision.unresolved_reason : null,
        },
      })
    }
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
        if (
          decision.association_state !== ReidAssociationState.RESOLVED ||
          typeof decision.selected_person_cluster_id !== 'string'
        )
          continue
        const tracklet = tracklets.get(String(decision.tracklet_id))
        if (!tracklet) continue
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
        const assignment = await tx.reidAssignmentRevision.create({
          data: {
            matchId,
            analysisRunId: run.evidenceSet.analysisRunId,
            trackletId: tracklet.id,
            personClusterId: decision.selected_person_cluster_id,
            rosterEntryId:
              typeof decision.selected_roster_entry_id === 'string'
                ? decision.selected_roster_entry_id
                : null,
            source: IdentitySource.AI,
            sourcePriority: 100,
            revision,
            effectiveFromSetNumber: submission.rally.set.setNumber,
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
          const selectedCandidate = records(decision.candidates).find(
            candidate => candidate.person_cluster_id === decision.selected_person_cluster_id,
          )
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
              confidence:
                selectedCandidate && typeof selectedCandidate.confidence === 'number'
                  ? selectedCandidate.confidence
                  : null,
              reidIdentityId: null,
              reidBindingId: null,
              identityRevision: revision,
            },
            create: {
              analysisRunId: run.evidenceSet.analysisRunId,
              trackId: tracklet.canonicalTrackId,
              rosterEntryId: assignment.rosterEntryId,
              source: IdentitySource.AI,
              confidence:
                selectedCandidate && typeof selectedCandidate.confidence === 'number'
                  ? selectedCandidate.confidence
                  : null,
              identityRevision: revision,
            },
          })
        }
      }
      await tx.match.update({ where: { id: matchId }, data: { identityRevision: revision } })
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
