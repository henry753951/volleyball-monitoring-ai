import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { ProviderWorkKind as ContractProviderWorkKind } from '@volleyball-monitoring/contracts'
import type { PrismaClient } from '@volleyball-monitoring/db'
import { Prisma, ProviderWorkKind } from '@volleyball-monitoring/db/client'

const callbackLifetimeMs = 30 * 60_000

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    )
  }
  return value
}

export function canonicalProviderRequest(value: Record<string, unknown>) {
  return JSON.stringify(canonical(value))
}

export function providerRequestSha256(value: Record<string, unknown>) {
  return createHash('sha256').update(canonicalProviderRequest(value)).digest('hex')
}

export function newProviderCallbackCredential(now = new Date()) {
  const token = randomBytes(32).toString('base64url')
  return {
    token,
    tokenHash: createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(now.getTime() + callbackLifetimeMs),
  }
}

export function acceptedProviderResultKinds(workKind: ContractProviderWorkKind): string[] {
  switch (workKind) {
    case 'ANALYSIS':
      return [
        'ANALYSIS_DATA',
        'ANALYSIS_EVIDENCE_MANIFEST',
        'PERSON_POSE_EVIDENCE_MANIFEST',
        'PERSON_POSE_EVIDENCE_CHUNK',
        'PLAYER_CROP_SOURCE_MANIFEST',
      ]
    case 'REID_FEATURE_EXTRACTION':
      return ['REID_FEATURE_RESULT', 'REID_DESCRIPTOR_BUNDLE']
    case 'REID_ASSOCIATION':
      return ['REID_ASSOCIATION_RESULT']
    case 'PERSON_POSE_EVIDENCE_REBUILD':
      return ['PERSON_POSE_EVIDENCE_MANIFEST', 'PERSON_POSE_EVIDENCE_CHUNK']
    case 'IDENTITY_PREVIEW_GENERATION':
      return ['IDENTITY_PREVIEW_RESULT', 'IDENTITY_PREVIEW']
  }
}

export function providerResultShapeError(
  workKind: ContractProviderWorkKind,
  artifactKinds: string[],
): string | null {
  const count = (kind: string) => artifactKinds.filter(value => value === kind).length
  const exactlyOne = (...kinds: string[]) => kinds.every(kind => count(kind) === 1)
  switch (workKind) {
    case 'ANALYSIS':
      return exactlyOne(
        'ANALYSIS_DATA',
        'ANALYSIS_EVIDENCE_MANIFEST',
        'PERSON_POSE_EVIDENCE_MANIFEST',
        'PLAYER_CROP_SOURCE_MANIFEST',
      ) && count('PERSON_POSE_EVIDENCE_CHUNK') >= 1
        ? null
        : 'Analysis result requires one data/evidence/pose/crop manifest and pose chunks'
    case 'REID_FEATURE_EXTRACTION':
      return exactlyOne('REID_FEATURE_RESULT', 'REID_DESCRIPTOR_BUNDLE') &&
        artifactKinds.length === 2
        ? null
        : 'ReID feature result requires exactly one result and one descriptor bundle'
    case 'REID_ASSOCIATION':
      return exactlyOne('REID_ASSOCIATION_RESULT') && artifactKinds.length === 1
        ? null
        : 'ReID association requires exactly one result artifact'
    case 'PERSON_POSE_EVIDENCE_REBUILD':
      return exactlyOne('PERSON_POSE_EVIDENCE_MANIFEST') && count('PERSON_POSE_EVIDENCE_CHUNK') >= 1
        ? null
        : 'Pose evidence rebuild requires one manifest and pose chunks'
    case 'IDENTITY_PREVIEW_GENERATION':
      return exactlyOne('IDENTITY_PREVIEW_RESULT', 'IDENTITY_PREVIEW')
        ? null
        : 'Identity preview requires one result manifest and one preview media artifact'
  }
}

export interface CreateProviderJobInput {
  workKind: ContractProviderWorkKind
  requestSchemaVersion: string
  resultSchemaVersion: string
  idempotencyKey: string
  request: Record<string, unknown>
  analysisRunId?: string | null
  parentProviderJobId?: string | null
  maxAttempts?: number
}

function databaseWorkKind(workKind: ContractProviderWorkKind): ProviderWorkKind {
  return ProviderWorkKind[workKind]
}

export async function createProviderJob(database: PrismaClient, input: CreateProviderJobInput) {
  const existing = await database.providerJob.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  })
  const id = existing?.id ?? randomUUID()
  const request = {
    ...input.request,
    schema_version: input.requestSchemaVersion,
    provider_job_id: id,
  }
  const requestPayloadHash = providerRequestSha256(request)
  const credential = newProviderCallbackCredential()
  if (existing) {
    if (
      existing.workKind !== databaseWorkKind(input.workKind) ||
      existing.requestSchemaVersion !== input.requestSchemaVersion ||
      existing.resultSchemaVersion !== input.resultSchemaVersion ||
      existing.requestPayloadHash !== requestPayloadHash
    ) {
      throw new Error('provider job idempotency key was already used for different work')
    }
    return { created: false as const, job: existing }
  }
  const job = await database.providerJob.create({
    data: {
      id,
      workKind: databaseWorkKind(input.workKind),
      idempotencyKey: input.idempotencyKey,
      requestSchemaVersion: input.requestSchemaVersion,
      resultSchemaVersion: input.resultSchemaVersion,
      requestPayload: json(request),
      requestPayloadHash,
      callbackTokenHash: credential.tokenHash,
      callbackTokenExpiresAt: credential.expiresAt,
      analysisRunId: input.analysisRunId ?? null,
      parentProviderJobId: input.parentProviderJobId ?? null,
      maxAttempts: input.maxAttempts ?? 5,
    },
  })
  return { created: true as const, job }
}
