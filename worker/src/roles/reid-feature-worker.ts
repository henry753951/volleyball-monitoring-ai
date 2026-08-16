import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { PrismaClient } from '@volleyball-monitoring/db'
import {
  ArtifactState,
  JobStatus,
  MediaAssetKind,
  Prisma,
  ProviderArtifactDirection,
  ProviderWorkKind,
  ReidEvidenceState,
} from '@volleyball-monitoring/db/client'
import Ajv2020 from 'ajv/dist/2020.js'
import {
  buildReidRosterSnapshot,
  canonicalJson,
  featureRecipeNamespace,
  isRecord,
  SHA256_PATTERN,
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

const FEATURE_LEASE_MS = 5 * 60_000
const JSON_MAX_BYTES = 32n * 1024n * 1024n
const DESCRIPTOR_MAX_BYTES = 512n * 1024n * 1024n
const FRAME_SELECTION_RECIPE = 'reid-frame-selection/pose-frontality-v1'
const DEFAULT_RECIPES = [
  { modality: 'DINO', model_namespace: 'dinov2/vits14-reg/v1' },
  { modality: 'OSNET', model_namespace: 'sports-osnet/x1/v1' },
  { modality: 'KPR_PROMPT', model_namespace: 'kpr/coco17-prompt/v1' },
  { modality: 'JERSEY_VLM', model_namespace: 'jersey-vlm/qwen-v1' },
] as const

const contractsRoot = new URL('../../../packages/contracts/ai/', import.meta.url)
const ajv = new Ajv2020({ allErrors: true, strict: false })
const validateFeatureRequest = ajv.compile(
  JSON.parse(await readFile(new URL('reid-feature-job.schema.json', contractsRoot), 'utf8')),
)
const validateFeatureResult = ajv.compile(
  JSON.parse(await readFile(new URL('reid-feature-result.schema.json', contractsRoot), 'utf8')),
)
const validateRosterSnapshot = ajv.compile(
  JSON.parse(await readFile(new URL('reid-roster-snapshot.schema.json', contractsRoot), 'utf8')),
)
const validateJerseyResponses = ajv.compile(
  JSON.parse(
    await readFile(new URL('reid-jersey-vlm-response.schema.json', contractsRoot), 'utf8'),
  ),
)

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
const records = (value: unknown) => (Array.isArray(value) ? value.filter(isRecord) : [])

export function sameCanonicalTrackCoverage(prior: number[], rebuilt: number[]) {
  const normalized = (values: number[]) => [...new Set(values)].sort((left, right) => left - right)
  const priorTracks = normalized(prior)
  return priorTracks.length > 0 && canonicalJson(priorTracks) === canonicalJson(normalized(rebuilt))
}

export function reidFeatureIdempotencyKey(input: {
  analysisRunId: string
  recipeNamespace: string
  evidenceContentSha256: string
  rebuildRequestId?: string | null
}) {
  return `reid-feature:${sha256Hex(canonicalJson(input))}`
}

type FeatureArtifact = {
  artifactKind: string
  schemaVersion: string
  sha256: string
  byteLength: bigint
  contentType: string
  mediaAsset: {
    id: string
    bucket: string
    objectKey: string
    byteLength: bigint | null
    sha256: string | null
  }
}

export function pgvectorLiteralFromDescriptor(
  descriptorBytes: Buffer,
  vector: { dimension: number; byteOffset: bigint; byteLength: bigint },
) {
  if (vector.dimension > 2_000) return null
  const offset = Number(vector.byteOffset)
  const length = Number(vector.byteLength)
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length !== vector.dimension * Float32Array.BYTES_PER_ELEMENT ||
    offset + length > descriptorBytes.byteLength
  )
    throw new ReidFeatureMaterializationError('pgvector descriptor byte range is invalid', false)
  const values = Array.from({ length: vector.dimension }, (_, index) =>
    descriptorBytes.readFloatLE(offset + index * Float32Array.BYTES_PER_ELEMENT),
  )
  if (values.some(value => !Number.isFinite(value)))
    throw new ReidFeatureMaterializationError(
      'pgvector descriptor contains a non-finite value',
      false,
    )
  return `[${values.join(',')}]`
}

export class ReidFeatureMaterializationError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'ReidFeatureMaterializationError'
  }
}

function materializationError(error: unknown, retryable = false): never {
  if (error instanceof ReidFeatureMaterializationError) throw error
  throw new ReidFeatureMaterializationError(
    error instanceof Error ? error.message : 'invalid ReID feature artifact',
    retryable,
  )
}

function oneArtifact(artifacts: FeatureArtifact[], kind: string, optional = false) {
  const matches = artifacts.filter(artifact => artifact.artifactKind === kind)
  if ((optional && matches.length > 1) || (!optional && matches.length !== 1))
    throw new ReidFeatureMaterializationError(
      `ReID feature result requires ${optional ? 'at most' : 'exactly'} one ${kind} artifact`,
      false,
    )
  return matches[0] ?? null
}

function referencedArtifact(
  artifacts: FeatureArtifact[],
  reference: unknown,
  kind: string,
): FeatureArtifact {
  if (
    !isRecord(reference) ||
    reference.kind !== kind ||
    typeof reference.sha256 !== 'string' ||
    typeof reference.byte_length !== 'string'
  )
    throw new ReidFeatureMaterializationError(`${kind} reference is invalid`, false)
  const artifact = artifacts.find(
    candidate =>
      candidate.artifactKind === kind &&
      candidate.sha256.toLowerCase() === String(reference.sha256).toLowerCase() &&
      candidate.byteLength.toString() === reference.byte_length,
  )
  if (!artifact)
    throw new ReidFeatureMaterializationError(
      `${kind} reference does not match a callback artifact`,
      false,
    )
  return artifact
}

async function readJsonArtifact(storage: WorkflowMinio, artifact: FeatureArtifact) {
  let parsed: unknown
  try {
    parsed = JSON.parse(
      (await readVerifiedObject(storage.client, artifact.mediaAsset, JSON_MAX_BYTES)).toString(
        'utf8',
      ),
    )
  } catch (error) {
    materializationError(error, !(error instanceof SyntaxError))
  }
  if (!isRecord(parsed))
    throw new ReidFeatureMaterializationError('ReID JSON artifact must be an object', false)
  return parsed
}

function assertUuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value))
    throw new ReidFeatureMaterializationError(`${label} must be a UUID`, false)
}

function assertFeaturePassthrough(
  request: Record<string, unknown>,
  result: Record<string, unknown>,
  providerJobId: string,
) {
  const expected = {
    provider_job_id: providerJobId,
    evidence_set_id: request.evidence_set_id,
    analysis_run_id: request.analysis_run_id,
    match_id: request.match_id,
  }
  for (const [key, value] of Object.entries(expected))
    if (result[key] !== value)
      throw new ReidFeatureMaterializationError(`ReID feature ${key} passthrough mismatch`, false)
  assertUuid(result.evidence_set_id, 'evidence_set_id')
  assertUuid(result.analysis_run_id, 'analysis_run_id')
  assertUuid(result.match_id, 'match_id')
}

type PlannedVector = {
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
}

type PlannedTracklet = {
  id: string
  canonicalTrackId: number
  trackIdAliases: number[]
  courtSide: 'LEFT' | 'RIGHT' | 'UNKNOWN'
  firstFrameIndex: bigint
  lastFrameIndex: bigint
  cannotLinkTrackletIds: string[]
  vectors: PlannedVector[]
  jersey: null | {
    modelNamespace: string
    rawResponseKey: string
    rawResponseSha256: string
    candidateNumbers: number[]
    selectedFrameIndices: bigint[]
  }
}

export function planReidFeatureRows(
  result: Record<string, unknown>,
  descriptorBytes: Buffer,
  validTrackIds: Set<number>,
  jerseyBundle: Record<string, unknown> | null,
): PlannedTracklet[] {
  const resultTracklets = records(result.tracklets)
  const trackletIds = new Set<string>()
  const canonicalTrackIds = new Set<number>()
  const vectorIds = new Set<string>()
  const ranges: Array<{ start: bigint; end: bigint; id: string }> = []
  const planned = resultTracklets.map(tracklet => {
    assertUuid(tracklet.tracklet_id, 'tracklet_id')
    const id = tracklet.tracklet_id
    const canonicalTrackId = Number(tracklet.canonical_track_id)
    const aliases = Array.isArray(tracklet.track_id_aliases)
      ? tracklet.track_id_aliases.map(Number)
      : []
    if (
      trackletIds.has(id) ||
      canonicalTrackIds.has(canonicalTrackId) ||
      !aliases.includes(canonicalTrackId) ||
      aliases.some(alias => !validTrackIds.has(alias))
    )
      throw new ReidFeatureMaterializationError('ReID tracklet identity is invalid', false)
    trackletIds.add(id)
    canonicalTrackIds.add(canonicalTrackId)
    const firstFrameIndex = BigInt(String(tracklet.first_frame_index))
    const lastFrameIndex = BigInt(String(tracklet.last_frame_index))
    const vectors = records(tracklet.vectors).map(vector => {
      assertUuid(vector.vector_id, 'vector_id')
      const vectorId = vector.vector_id
      if (vectorIds.has(vectorId))
        throw new ReidFeatureMaterializationError('ReID vector ids must be unique', false)
      vectorIds.add(vectorId)
      const dimension = Number(vector.dimension)
      const byteOffset = BigInt(String(vector.byte_offset))
      const byteLength = BigInt(String(vector.byte_length))
      const end = byteOffset + byteLength
      if (
        byteLength !== BigInt(dimension * 4) ||
        byteOffset < 0n ||
        end > BigInt(descriptorBytes.byteLength)
      )
        throw new ReidFeatureMaterializationError('ReID vector byte range is invalid', false)
      const bytes = descriptorBytes.subarray(Number(byteOffset), Number(end))
      const vectorSha = String(vector.sha256).toLowerCase()
      if (!SHA256_PATTERN.test(vectorSha) || sha256Hex(bytes) !== vectorSha)
        throw new ReidFeatureMaterializationError('ReID vector hash does not match bytes', false)
      const sourceFrameIndices = Array.isArray(vector.source_frame_indices)
        ? vector.source_frame_indices.map(frame => BigInt(String(frame)))
        : []
      if (
        sourceFrameIndices.some(frame => frame < firstFrameIndex || frame > lastFrameIndex) ||
        new Set(sourceFrameIndices.map(String)).size !== sourceFrameIndices.length
      )
        throw new ReidFeatureMaterializationError('ReID vector source frame is invalid', false)
      ranges.push({ start: byteOffset, end, id: vectorId })
      return {
        id: vectorId,
        modality: String(vector.modality),
        modelNamespace: String(vector.model_namespace),
        dimension,
        normalization: String(vector.normalization),
        distance: String(vector.distance),
        byteOffset,
        byteLength,
        sha256: vectorSha,
        sourceFrameIndices,
      }
    })
    const jersey = isRecord(tracklet.jersey_vlm)
      ? {
          modelNamespace: String(tracklet.jersey_vlm.model_namespace),
          rawResponseKey: String(tracklet.jersey_vlm.raw_response_key),
          rawResponseSha256: String(tracklet.jersey_vlm.raw_response_sha256).toLowerCase(),
          candidateNumbers: Array.isArray(tracklet.jersey_vlm.candidate_numbers)
            ? tracklet.jersey_vlm.candidate_numbers.map(Number)
            : [],
          selectedFrameIndices: Array.isArray(tracklet.jersey_vlm.selected_frame_indices)
            ? tracklet.jersey_vlm.selected_frame_indices.map(frame => BigInt(String(frame)))
            : [],
        }
      : null
    return {
      id,
      canonicalTrackId,
      trackIdAliases: aliases,
      courtSide: String(tracklet.court_side) as PlannedTracklet['courtSide'],
      firstFrameIndex,
      lastFrameIndex,
      cannotLinkTrackletIds: Array.isArray(tracklet.cannot_link_tracklet_ids)
        ? tracklet.cannot_link_tracklet_ids.map(String)
        : [],
      vectors,
      jersey,
    }
  })

  ranges.sort((left, right) => Number(left.start - right.start))
  for (let index = 1; index < ranges.length; index += 1)
    if (ranges[index]!.start < ranges[index - 1]!.end)
      throw new ReidFeatureMaterializationError('ReID vector byte ranges overlap', false)

  for (const tracklet of planned)
    for (const cannotLinkId of tracklet.cannotLinkTrackletIds) {
      if (cannotLinkId === tracklet.id || !trackletIds.has(cannotLinkId))
        throw new ReidFeatureMaterializationError('ReID cannot-link target is invalid', false)
      const peer = planned.find(candidate => candidate.id === cannotLinkId)!
      if (!peer.cannotLinkTrackletIds.includes(tracklet.id))
        throw new ReidFeatureMaterializationError('ReID cannot-links must be symmetric', false)
    }

  const jerseyResponses = jerseyBundle ? records(jerseyBundle.responses) : []
  const responseByKey = new Map(
    jerseyResponses.map(response => [String(response.response_key), response]),
  )
  const usedKeys = new Set<string>()
  for (const tracklet of planned) {
    if (!tracklet.jersey) continue
    const response = responseByKey.get(tracklet.jersey.rawResponseKey)
    if (
      !response ||
      response.tracklet_id !== tracklet.id ||
      response.model_namespace !== tracklet.jersey.modelNamespace ||
      String(response.raw_response_sha256).toLowerCase() !== tracklet.jersey.rawResponseSha256 ||
      canonicalJson(response.candidate_numbers) !==
        canonicalJson(tracklet.jersey.candidateNumbers) ||
      canonicalJson(response.selected_frame_indices) !==
        canonicalJson(tracklet.jersey.selectedFrameIndices.map(String))
    )
      throw new ReidFeatureMaterializationError('VLM raw response linkage is invalid', false)
    const raw = String(response.raw_response)
    if (sha256Hex(raw) !== tracklet.jersey.rawResponseSha256)
      throw new ReidFeatureMaterializationError('VLM raw response hash does not match', false)
    usedKeys.add(tracklet.jersey.rawResponseKey)
  }
  if (usedKeys.size !== jerseyResponses.length)
    throw new ReidFeatureMaterializationError(
      'VLM raw response bundle has unreferenced entries',
      false,
    )
  return planned
}

export async function materializeReidFeatureResult(
  database: PrismaClient,
  storage: WorkflowMinio,
  providerJob: {
    id: string
    analysisRunId: string | null
    requestPayload: Prisma.JsonValue
    artifacts: FeatureArtifact[]
  },
) {
  const request = isRecord(providerJob.requestPayload) ? providerJob.requestPayload : null
  if (!request || !providerJob.analysisRunId)
    throw new ReidFeatureMaterializationError('ReID feature provider request is invalid', false)
  const resultArtifact = oneArtifact(providerJob.artifacts, 'REID_FEATURE_RESULT')!
  const result = await readJsonArtifact(storage, resultArtifact)
  if (!validateFeatureResult(result))
    throw new ReidFeatureMaterializationError('ReID feature result failed schema validation', false)
  try {
    verifiedSemanticContentSha(result, 'ReID feature result')
  } catch (error) {
    materializationError(error)
  }
  assertFeaturePassthrough(request, result, providerJob.id)
  const descriptorArtifact = referencedArtifact(
    providerJob.artifacts,
    result.descriptor_artifact,
    'REID_DESCRIPTOR_BUNDLE',
  )
  let descriptorBytes: Buffer
  try {
    descriptorBytes = await readVerifiedObject(
      storage.client,
      descriptorArtifact.mediaAsset,
      DESCRIPTOR_MAX_BYTES,
    )
  } catch (error) {
    materializationError(error, true)
  }

  const jerseyReference = result.jersey_vlm_response_artifact
  const jerseyArtifact = jerseyReference
    ? referencedArtifact(providerJob.artifacts, jerseyReference, 'JERSEY_VLM_RESPONSE')
    : null
  if (
    Boolean(jerseyArtifact) !==
    Boolean(oneArtifact(providerJob.artifacts, 'JERSEY_VLM_RESPONSE', true))
  )
    throw new ReidFeatureMaterializationError('VLM response artifact shape is inconsistent', false)
  const jerseyBundle = jerseyArtifact ? await readJsonArtifact(storage, jerseyArtifact) : null
  if (jerseyBundle) {
    if (!validateJerseyResponses(jerseyBundle))
      throw new ReidFeatureMaterializationError(
        'VLM response bundle failed schema validation',
        false,
      )
    try {
      verifiedSemanticContentSha(jerseyBundle, 'VLM response bundle')
    } catch (error) {
      materializationError(error)
    }
    if (
      jerseyBundle.provider_job_id !== providerJob.id ||
      jerseyBundle.evidence_set_id !== result.evidence_set_id
    )
      throw new ReidFeatureMaterializationError('VLM response bundle passthrough mismatch', false)
  }

  const run = await database.analysisRun.findUnique({
    where: { id: providerJob.analysisRunId },
    include: { tracks: { select: { trackId: true } }, analysisEvidenceBundle: true },
  })
  if (!run || !run.analysisEvidenceBundle)
    throw new ReidFeatureMaterializationError('analysis evidence bundle is unavailable', true)
  const analysisEvidenceBundle = run.analysisEvidenceBundle
  const planned = planReidFeatureRows(
    result,
    descriptorBytes,
    new Set(run.tracks.map(track => track.trackId)),
    jerseyBundle,
  )
  const recipeNamespace = featureRecipeNamespace(
    String(request.frame_selection_recipe_version),
    records(request.requested_recipes).map(recipe => ({
      modality: String(recipe.modality),
      model_namespace: String(recipe.model_namespace),
    })),
  )
  const evidenceSetId = String(result.evidence_set_id)
  return database.$transaction(async tx => {
    const rebuildRequest = await tx.reidFeatureRebuildRequest.findUnique({
      where: { providerJobId: providerJob.id },
    })
    const existing = await tx.reidEvidenceSet.findUnique({
      where: { providerJobId: providerJob.id },
    })
    if (existing) {
      await tx.providerJob.update({
        where: { id: providerJob.id },
        data: { stage: 'materialized', leasedUntil: null },
      })
      if (rebuildRequest)
        await tx.reidFeatureRebuildRequest.update({
          where: { id: rebuildRequest.id },
          data: { status: JobStatus.COMPLETED, completedAt: new Date(), errorMessage: null },
        })
      return existing.id
    }
    const priorTracklets = rebuildRequest
      ? await tx.reidTracklet.findMany({
          where: {
            evidenceSet: {
              analysisRunId: run.id,
              recipeNamespace,
              status: ArtifactState.READY,
              supersededAt: null,
            },
          },
          include: {
            activeProjection: { include: { assignmentRevision: true } },
            memberships: {
              where: {
                evidenceState: ReidEvidenceState.CONFIRMED,
                supersededByMemberships: { none: {} },
              },
            },
          },
        })
      : []
    if (rebuildRequest) {
      if (
        !sameCanonicalTrackCoverage(
          priorTracklets.map(row => row.canonicalTrackId),
          planned.map(row => row.canonicalTrackId),
        )
      )
        throw new ReidFeatureMaterializationError(
          'ReID feature rebuild cannot replace the active generation with different canonical track coverage',
          false,
        )
    }
    const evidenceSet = await tx.reidEvidenceSet.create({
      data: {
        id: evidenceSetId,
        analysisRunId: run.id,
        analysisEvidenceBundleId: analysisEvidenceBundle.id,
        providerJobId: providerJob.id,
        schemaVersion: String(result.schema_version),
        recipeNamespace,
        resultAssetId: resultArtifact.mediaAsset.id,
        descriptorBundleAssetId: descriptorArtifact.mediaAsset.id,
        contentSha256: String(result.content_sha256).toLowerCase(),
        resultStatus: String(result.status),
        unavailableEvidence: json(result.unavailable_evidence),
        status: ArtifactState.READY,
        readyAt: new Date(),
      },
    })
    for (const tracklet of planned) {
      await tx.reidTracklet.create({
        data: {
          id: tracklet.id,
          evidenceSetId: evidenceSet.id,
          canonicalTrackId: tracklet.canonicalTrackId,
          trackIdAliases: tracklet.trackIdAliases,
          courtSide: tracklet.courtSide,
          firstFrameIndex: tracklet.firstFrameIndex,
          lastFrameIndex: tracklet.lastFrameIndex,
          cannotLinkTrackletIds: tracklet.cannotLinkTrackletIds,
          vectors: {
            create: tracklet.vectors.map(vector => ({
              id: vector.id,
              modality: vector.modality,
              modelNamespace: vector.modelNamespace,
              dimension: vector.dimension,
              normalization: vector.normalization,
              distance: vector.distance,
              byteOffset: vector.byteOffset,
              byteLength: vector.byteLength,
              sha256: vector.sha256,
              sourceFrameIndices: vector.sourceFrameIndices,
            })),
          },
          ...(tracklet.jersey && jerseyArtifact
            ? {
                jerseyVlmEvidence: {
                  create: {
                    modelNamespace: tracklet.jersey.modelNamespace,
                    rawResponseAssetId: jerseyArtifact.mediaAsset.id,
                    rawResponseKey: tracklet.jersey.rawResponseKey,
                    rawResponseSha256: tracklet.jersey.rawResponseSha256,
                    candidateNumbers: tracklet.jersey.candidateNumbers,
                    selectedFrameIndices: tracklet.jersey.selectedFrameIndices,
                  },
                },
              }
            : {}),
        },
      })
      for (const vector of tracklet.vectors) {
        const embedding = pgvectorLiteralFromDescriptor(descriptorBytes, vector)
        if (!embedding) continue
        await tx.$executeRaw`
          INSERT INTO "ReidSearchEmbedding"
            ("featureVectorId", "modelNamespace", "modality", "dimension", "distance", "embedding")
          VALUES
            (${vector.id}::uuid, ${vector.modelNamespace}, ${vector.modality}, ${vector.dimension}, ${vector.distance}, ${embedding}::vector)
          ON CONFLICT ("featureVectorId") DO NOTHING
        `
      }
    }
    if (rebuildRequest) {
      const matchId = String(result.match_id)
      await tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${matchId}::uuid FOR UPDATE`
      let identityRevision = (
        await tx.match.findUniqueOrThrow({
          where: { id: matchId },
          select: { identityRevision: true },
        })
      ).identityRevision
      const evidenceGenerationRevision = priorTracklets.some(row => row.memberships.length > 0)
        ? (identityRevision += 1n)
        : null
      for (const rebuiltTracklet of planned) {
        const priorTracklet = priorTracklets.find(
          row => row.canonicalTrackId === rebuiltTracklet.canonicalTrackId,
        )
        if (!priorTracklet) continue
        for (const membership of priorTracklet.memberships)
          await tx.reidEvidenceMembership.create({
            data: {
              personClusterId: membership.personClusterId,
              trackletId: rebuiltTracklet.id,
              rosterEntryId: membership.rosterEntryId,
              evidenceState: membership.evidenceState,
              evidenceRole: membership.evidenceRole,
              weight: membership.weight,
              sourceRevision: evidenceGenerationRevision!,
              supersedesMembershipId: membership.id,
              correctionId: membership.correctionId,
              createdByUserId: membership.createdByUserId,
            },
          })
        const active = priorTracklet.activeProjection
        if (!active || active.sourcePriority < 1_000) continue
        identityRevision += 1n
        const source = active.assignmentRevision
        const assignment = await tx.reidAssignmentRevision.create({
          data: {
            matchId,
            analysisRunId: run.id,
            trackletId: rebuiltTracklet.id,
            personClusterId: source.personClusterId,
            rosterEntryId: source.rosterEntryId,
            correctionId: source.correctionId,
            source: source.source,
            sourcePriority: source.sourcePriority,
            revision: identityRevision,
            effectiveFromSetNumber: source.effectiveFromSetNumber,
            effectiveFromRallyOrdinal: source.effectiveFromRallyOrdinal,
            createdByUserId: source.createdByUserId,
          },
        })
        await tx.reidActiveProjection.create({
          data: {
            analysisRunId: run.id,
            trackletId: rebuiltTracklet.id,
            assignmentRevisionId: assignment.id,
            sourcePriority: assignment.sourcePriority,
          },
        })
      }
      await tx.reidEvidenceSet.updateMany({
        where: {
          id: { not: evidenceSet.id },
          analysisRunId: run.id,
          recipeNamespace,
          supersededAt: null,
        },
        data: { supersededAt: new Date(), supersededByEvidenceSetId: evidenceSet.id },
      })
      await tx.match.update({ where: { id: matchId }, data: { identityRevision } })
      await tx.reidFeatureRebuildRequest.update({
        where: { id: rebuildRequest.id },
        data: { status: JobStatus.COMPLETED, completedAt: new Date(), errorMessage: null },
      })
    }
    const pairKeys = new Set<string>()
    const cannotLinks: Array<{ leftTrackletId: string; rightTrackletId: string }> = []
    for (const tracklet of planned)
      for (const peerId of tracklet.cannotLinkTrackletIds) {
        const [leftTrackletId, rightTrackletId] = [tracklet.id, peerId].sort()
        const key = `${leftTrackletId}:${rightTrackletId}`
        if (pairKeys.has(key)) continue
        pairKeys.add(key)
        cannotLinks.push({ leftTrackletId: leftTrackletId!, rightTrackletId: rightTrackletId! })
      }
    if (cannotLinks.length)
      await tx.reidCannotLink.createMany({
        data: cannotLinks.map(pair => ({
          matchId: String(result.match_id),
          ...pair,
          reason: 'CO_VISIBILITY',
          sourceRevision: 0n,
        })),
      })
    await tx.providerJob.update({
      where: { id: providerJob.id },
      data: { stage: 'materialized', leasedUntil: null, errorCode: null, errorMessage: null },
    })
    return evidenceSet.id
  })
}

export async function scheduleReidFeatureExtraction(
  database: PrismaClient,
  storage: WorkflowMinio,
) {
  const failedRebuilds = await database.reidFeatureRebuildRequest.findMany({
    where: {
      status: JobStatus.RUNNING,
      providerJob: { status: { in: [JobStatus.FAILED, JobStatus.CANCELLED] } },
    },
    select: { id: true, providerJob: { select: { errorMessage: true } } },
  })
  for (const request of failedRebuilds)
    await database.reidFeatureRebuildRequest.update({
      where: { id: request.id },
      data: {
        status: JobStatus.FAILED,
        completedAt: new Date(),
        errorMessage: request.providerJob?.errorMessage ?? 'ReID feature provider job failed',
      },
    })
  const rebuildRequest = await database.reidFeatureRebuildRequest.findFirst({
    where: { status: JobStatus.QUEUED },
    orderBy: { createdAt: 'asc' },
  })
  const candidate = await database.analysisEvidenceBundle.findFirst({
    where: rebuildRequest
      ? {
          analysisRunId: rebuildRequest.analysisRunId,
          status: ArtifactState.READY,
          analysisRun: { status: JobStatus.COMPLETED },
        }
      : {
          status: ArtifactState.READY,
          analysisRun: {
            status: JobStatus.COMPLETED,
            providerJobs: { none: { workKind: ProviderWorkKind.REID_FEATURE_EXTRACTION } },
          },
        },
    orderBy: { createdAt: 'asc' },
    include: {
      manifestAsset: true,
      cropSourceManifestAsset: true,
      poseManifests: {
        where: { status: ArtifactState.READY },
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: {
          manifestAsset: true,
          chunks: { orderBy: { chunkIndex: 'asc' }, include: { asset: true } },
        },
      },
      analysisRun: {
        include: {
          rawAnalysisDataAsset: true,
          aiJob: { include: { clipJob: { include: { clipAsset: true } } } },
          submission: { include: { rally: true } },
          providerJobs: {
            where: { workKind: ProviderWorkKind.ANALYSIS },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      },
    },
  })
  if (!candidate) return false
  const run = candidate.analysisRun
  const pose = candidate.poseManifests[0]
  const clipAsset = run.aiJob.clipJob.clipAsset
  const rawAnalysisDataAsset = run.rawAnalysisDataAsset
  const cropSourceManifestAsset = candidate.cropSourceManifestAsset
  if (!pose || !cropSourceManifestAsset || !rawAnalysisDataAsset || !clipAsset) return false
  const matchId = run.submission.rally.matchId
  const entries = await database.matchRosterEntry.findMany({
    where: {
      matchId,
      teamId: { in: [run.submission.leftTeamId, run.submission.rightTeamId] },
    },
  })
  const rosterSnapshot = buildReidRosterSnapshot({
    snapshotId: `roster/${run.id}/${candidate.contentSha256}`,
    matchId,
    submissionId: run.submissionId,
    setNumber: run.submission.rally.displaySetNumber,
    rallyOrdinal: run.submission.rally.ordinal,
    leftTeamId: run.submission.leftTeamId,
    rightTeamId: run.submission.rightTeamId,
    entries,
  })
  if (!validateRosterSnapshot(rosterSnapshot))
    throw new ReidFeatureMaterializationError('generated roster snapshot is invalid', false)
  const rosterBytes = Buffer.from(`${canonicalJson(rosterSnapshot)}\n`, 'utf8')
  const objectKey = `reid/rosters/${rosterSnapshot.content_sha256}.json`
  const upload = await putVerifiedBuffer(
    storage.client,
    storage.analysisBucket,
    objectKey,
    rosterBytes,
    'application/vnd.volleyball.reid-roster-snapshot+json;version=1',
    {
      'x-amz-meta-artifact-kind': 'REID_ROSTER_SNAPSHOT',
      'x-amz-meta-internal-schema-version': '1.0.0',
    },
  )
  const requestedRecipes = DEFAULT_RECIPES.map(recipe => ({ ...recipe }))
  const recipeNamespace = featureRecipeNamespace(FRAME_SELECTION_RECIPE, requestedRecipes)
  const idempotencyKey = reidFeatureIdempotencyKey({
    analysisRunId: run.id,
    recipeNamespace,
    evidenceContentSha256: candidate.contentSha256,
    rebuildRequestId: rebuildRequest?.id ?? null,
  })
  return database.$transaction(async tx => {
    if (rebuildRequest) {
      const claimed = await tx.reidFeatureRebuildRequest.updateMany({
        where: { id: rebuildRequest.id, status: JobStatus.QUEUED },
        data: { status: JobStatus.RUNNING, startedAt: new Date(), errorMessage: null },
      })
      if (claimed.count !== 1) return false
    }
    const existingJob = await tx.providerJob.findUnique({ where: { idempotencyKey } })
    if (existingJob) {
      if (rebuildRequest)
        await tx.reidFeatureRebuildRequest.update({
          where: { id: rebuildRequest.id },
          data: { providerJobId: existingJob.id },
        })
      return false
    }
    const rosterAsset = await tx.mediaAsset.upsert({
      where: { bucket_objectKey: { bucket: storage.analysisBucket, objectKey } },
      update: {},
      create: {
        kind: MediaAssetKind.REID_EVIDENCE,
        bucket: storage.analysisBucket,
        objectKey,
        contentType: 'application/vnd.volleyball.reid-roster-snapshot+json;version=1',
        byteLength: upload.byteLength,
        sha256: upload.sha256,
        internalSchemaVersion: '1.0.0',
        state: ArtifactState.READY,
        readyAt: new Date(),
      },
    })
    if (rosterAsset.sha256 !== upload.sha256 || rosterAsset.byteLength !== upload.byteLength)
      throw new ReidFeatureMaterializationError('content-addressed roster asset mismatch', false)
    const providerJobId = randomUUID()
    const evidenceSetId = randomUUID()
    const analysisManifestInput = {
      id: randomUUID(),
      mediaAsset: candidate.manifestAsset,
      artifactKind: 'ANALYSIS_EVIDENCE_MANIFEST',
      schemaVersion: candidate.schemaVersion,
    }
    const rosterInput = {
      id: randomUUID(),
      mediaAsset: rosterAsset,
      artifactKind: 'REID_ROSTER_SNAPSHOT',
      schemaVersion: '1.0.0',
    }
    const inputs = [
      {
        id: randomUUID(),
        mediaAsset: clipAsset,
        artifactKind: 'CANONICAL_CLIP',
        schemaVersion: clipAsset.internalSchemaVersion ?? '1.0.0',
      },
      {
        id: randomUUID(),
        mediaAsset: rawAnalysisDataAsset,
        artifactKind: 'ANALYSIS_DATA',
        schemaVersion: run.analysisDataSchemaVersion,
      },
      analysisManifestInput,
      {
        id: randomUUID(),
        mediaAsset: pose.manifestAsset,
        artifactKind: 'PERSON_POSE_EVIDENCE_MANIFEST',
        schemaVersion: pose.schemaVersion,
      },
      ...pose.chunks.map(chunk => ({
        id: randomUUID(),
        mediaAsset: chunk.asset,
        artifactKind: 'PERSON_POSE_EVIDENCE_CHUNK',
        schemaVersion: pose.schemaVersion,
      })),
      {
        id: randomUUID(),
        mediaAsset: cropSourceManifestAsset,
        artifactKind: 'PLAYER_CROP_SOURCE_MANIFEST',
        schemaVersion: '1.0.0',
      },
      rosterInput,
    ]
    const request = {
      schema_version: '1.0.0',
      provider_job_id: providerJobId,
      evidence_set_id: evidenceSetId,
      analysis_run_id: run.analysisId,
      match_id: matchId,
      analysis_evidence_artifact_id: analysisManifestInput.id,
      roster_snapshot_artifact_id: rosterInput.id,
      pose_recipe_namespace: pose.recipeNamespace,
      frame_selection_recipe_version: FRAME_SELECTION_RECIPE,
      requested_recipes: requestedRecipes,
    }
    if (!validateFeatureRequest(request))
      throw new ReidFeatureMaterializationError('generated ReID feature request is invalid', false)
    const token = randomBytes(32).toString('base64url')
    if (
      inputs.some(
        input =>
          input.mediaAsset.state !== ArtifactState.READY ||
          input.mediaAsset.sha256 === null ||
          input.mediaAsset.byteLength === null,
      )
    )
      throw new ReidFeatureMaterializationError('ReID feature input artifact is not ready', true)
    await tx.providerJob.create({
      data: {
        id: providerJobId,
        workKind: ProviderWorkKind.REID_FEATURE_EXTRACTION,
        idempotencyKey,
        requestSchemaVersion: '1.0.0',
        resultSchemaVersion: '1.0.0',
        requestPayload: json(request),
        requestPayloadHash: sha256Hex(canonicalJson(request)),
        callbackTokenHash: sha256Hex(token),
        callbackTokenExpiresAt: new Date(Date.now() + 30 * 60_000),
        analysisRunId: run.id,
        parentProviderJobId: run.providerJobs[0]?.id ?? null,
        stage: 'feature_queued',
        artifacts: {
          create: inputs.map((input, ordinal) => ({
            id: input.id,
            mediaAssetId: input.mediaAsset.id,
            direction: ProviderArtifactDirection.INPUT,
            artifactKind: input.artifactKind,
            ordinal,
            required: true,
            schemaVersion: input.schemaVersion,
            sha256: input.mediaAsset.sha256!,
            byteLength: input.mediaAsset.byteLength!,
            contentType: input.mediaAsset.contentType,
          })),
        },
      },
    })
    if (rebuildRequest)
      await tx.reidFeatureRebuildRequest.update({
        where: { id: rebuildRequest.id },
        data: { providerJobId },
      })
    return true
  })
}

export function createReidFeatureWorker(
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
        workKind: ProviderWorkKind.REID_FEATURE_EXTRACTION,
        status: JobStatus.COMPLETED,
        OR: [
          { stage: 'completed' },
          { stage: 'feature_materializing', leasedUntil: { lt: currentTime } },
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
    if (!candidate) return scheduleReidFeatureExtraction(database, storage)
    const claimed = await database.providerJob.updateMany({
      where: {
        id: candidate.id,
        status: JobStatus.COMPLETED,
        OR: [
          { stage: 'completed' },
          { stage: 'feature_materializing', leasedUntil: { lt: currentTime } },
        ],
      },
      data: {
        stage: 'feature_materializing',
        leasedUntil: new Date(currentTime.getTime() + FEATURE_LEASE_MS),
        errorCode: null,
        errorMessage: null,
      },
    })
    if (claimed.count !== 1) return false
    try {
      await materializeReidFeatureResult(database, storage, candidate)
    } catch (error) {
      const terminal = error instanceof ReidFeatureMaterializationError && !error.retryable
      await database.providerJob.update({
        where: { id: candidate.id },
        data: {
          stage: terminal ? 'feature_materialization_failed' : 'completed',
          leasedUntil: null,
          availableAt: new Date(now().getTime() + (terminal ? 0 : 30_000)),
          errorCode: terminal
            ? 'INVALID_REID_FEATURE_ARTIFACTS'
            : 'REID_FEATURE_MATERIALIZATION_RETRY',
          errorMessage: (error instanceof Error
            ? error.message
            : 'unknown materialization failure'
          ).slice(0, 1_000),
        },
      })
      if (terminal)
        await database.reidFeatureRebuildRequest.updateMany({
          where: { providerJobId: candidate.id, status: JobStatus.RUNNING },
          data: {
            status: JobStatus.FAILED,
            completedAt: new Date(),
            errorMessage: (error instanceof Error
              ? error.message
              : 'unknown materialization failure'
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
        'reid-feature-worker loop error',
        error instanceof Error ? error.name : 'UnknownError',
      )
      options.onError?.(error)
    },
    ...(options.disconnectOnStop === false ? {} : { disconnect: () => database.$disconnect() }),
  })
}
