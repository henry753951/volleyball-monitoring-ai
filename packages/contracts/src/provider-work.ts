export const PROVIDER_WORK_REALTIME_VERSION = '2.0.0' as const
export const PROVIDER_WORK_CAPABILITIES_VERSION = '3.0.0' as const
export const PROVIDER_WORK_ENVELOPE_VERSION = '1.0.0' as const

export const PROVIDER_WORK_KINDS = [
  'ANALYSIS',
  'REID_FEATURE_EXTRACTION',
  'REID_ASSOCIATION',
  'PERSON_POSE_EVIDENCE_REBUILD',
  'IDENTITY_PREVIEW_GENERATION',
] as const

export type ProviderWorkKind = (typeof PROVIDER_WORK_KINDS)[number]
export type ProviderAccelerator = 'CPU' | 'CUDA' | 'MPS' | 'ANY'

export interface ProviderWorkCapability {
  work_kind: ProviderWorkKind
  request_schema_versions: string[]
  result_schema_versions: string[]
  accepted_input_artifact_kinds: string[]
  produced_artifact_kinds: string[]
  model_recipe_namespaces: string[]
  hardware: {
    accelerator: ProviderAccelerator
    minimum_memory_bytes?: string
  }
  max_concurrency: number
}

export interface ProviderWorkCapabilities {
  schema_version: '3.0.0'
  provider_name: string
  provider_build_id: string
  work_capabilities: ProviderWorkCapability[]
}

export interface ProviderInputArtifact {
  artifact_id: string
  kind: string
  schema_version: string
  download_url: string
  download_url_expires_at: string
  sha256: string
  byte_length: string
  content_type: string
}

export interface ProviderWorkEnvelope<
  Request extends Record<string, unknown> = Record<string, unknown>,
> {
  schema_version: '1.0.0'
  provider_job_id: string
  work_kind: ProviderWorkKind
  request_schema_version: string
  request_sha256: string
  idempotency_key: string
  input_artifacts: ProviderInputArtifact[]
  request: Request
  callback: {
    url: string
    token: string
    expires_at: string
    accepted_result_kinds: string[]
  }
}

export interface ProviderActiveWork {
  provider_job_id: string
  work_kind: ProviderWorkKind
  delivery_id: string
  progress?: number
}

interface ProviderWorkIdentity {
  schema_version: '2.0.0'
  provider_job_id: string
  work_kind: ProviderWorkKind
  delivery_id: string
}

export type ProviderWorkClientMessage =
  | {
      schema_version: '2.0.0'
      type: 'provider_hello'
      instance_id: string
      sdk_version: string
      provider_build_id: string
      capabilities: ProviderWorkCapabilities
      active_work: ProviderActiveWork[]
    }
  | {
      schema_version: '2.0.0'
      type: 'heartbeat' | 'resume_request'
      instance_id: string
      active_work: ProviderActiveWork[]
    }
  | (ProviderWorkIdentity & { type: 'job_accepted'; accepted_at: string })
  | (ProviderWorkIdentity & {
      type: 'job_rejected' | 'job_failed'
      code: string
      message: string
      retryable: boolean
    })
  | (ProviderWorkIdentity & { type: 'progress'; progress: number; stage?: string | null })
  | (ProviderWorkIdentity & { type: 'abort_ack'; acknowledged_at: string })

export type ProviderWorkServerMessage =
  | {
      schema_version: '2.0.0'
      type: 'connection_ready'
      connection_id: string
      server_time: string
      heartbeat_interval_seconds: number
      lease_seconds: number
    }
  | (ProviderWorkIdentity & {
      type: 'job_offer'
      lease_expires_at: string
      work: ProviderWorkEnvelope
    })
  | (ProviderWorkIdentity & {
      type: 'lease_renewed' | 'resume_job'
      lease_expires_at: string
    })
  | (ProviderWorkIdentity & { type: 'abort_job' | 'discard_job'; reason: string })
  | (ProviderWorkIdentity & { type: 'job_committed'; committed_at: string })
  | {
      schema_version: '2.0.0'
      type: 'protocol_error'
      code: string
      message: string
      retryable: boolean
    }

export interface ReidFeatureJobRequest extends Record<string, unknown> {
  schema_version: '2.0.0'
  provider_job_id: string
  evidence_set_id: string
  analysis_run_id: string
  match_id: string
  analysis_evidence_artifact_id: string
  roster_snapshot_artifact_id: string
  pose_recipe_namespace: string
  frame_selection_recipe_version: string
  requested_recipes: Array<{
    modality: 'DINO' | 'OSNET' | 'KPR' | 'KPR_PROMPT'
    model_namespace: string
  }>
}

export interface ReidAssociationJobRequest extends Record<string, unknown> {
  schema_version: '2.0.0'
  provider_job_id: string
  association_run_id: string
  match_id: string
  evidence_set_id: string
  eligible_tracklet_ids: string[]
  evidence_result_artifact_id: string
  bank_snapshot_id: string
  bank_snapshot_artifact_id: string
  roster_snapshot_artifact_id: string
  recipe: {
    namespace: string
    candidate_modalities: Array<'DINO' | 'OSNET' | 'KPR' | 'KPR_PROMPT'>
    same_clip_grouping: boolean
    allow_new_gid: true
    manual_assignment_precedence: true
    team_occupancy_prior: {
      expected_count: number
      enforcement: 'SOFT'
    }
  }
}

const UINT = /^\d+$/
const SHA256 = /^[a-fA-F0-9]{64}$/
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const hasOnly = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
) =>
  required.every(key => key in value) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key))
const nonEmptyString = (value: unknown, maximum = 128): value is string =>
  typeof value === 'string' && value.length >= 1 && value.length <= maximum
const stringArray = (value: unknown, allowEmpty = true): value is string[] =>
  Array.isArray(value) &&
  (allowEmpty || value.length > 0) &&
  new Set(value).size === value.length &&
  value.every(item => nonEmptyString(item, 256))
const validDate = (value: unknown) => typeof value === 'string' && !Number.isNaN(Date.parse(value))
const validProgress = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
const validUri = (value: unknown) => {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}
const validWorkKind = (value: unknown): value is ProviderWorkKind =>
  PROVIDER_WORK_KINDS.includes(value as ProviderWorkKind)

function parseHardware(value: unknown): ProviderWorkCapability['hardware'] {
  if (
    !isRecord(value) ||
    !hasOnly(value, ['accelerator'], ['minimum_memory_bytes']) ||
    !['CPU', 'CUDA', 'MPS', 'ANY'].includes(String(value.accelerator)) ||
    (value.minimum_memory_bytes !== undefined &&
      (typeof value.minimum_memory_bytes !== 'string' || !UINT.test(value.minimum_memory_bytes)))
  )
    throw new TypeError('invalid provider work hardware capability')
  return value as unknown as ProviderWorkCapability['hardware']
}

export function parseProviderWorkCapabilities(input: unknown): ProviderWorkCapabilities {
  if (
    !isRecord(input) ||
    !hasOnly(input, [
      'schema_version',
      'provider_name',
      'provider_build_id',
      'work_capabilities',
    ]) ||
    input.schema_version !== PROVIDER_WORK_CAPABILITIES_VERSION ||
    !nonEmptyString(input.provider_name) ||
    !nonEmptyString(input.provider_build_id) ||
    !Array.isArray(input.work_capabilities) ||
    input.work_capabilities.length === 0
  )
    throw new TypeError('invalid provider work capabilities')
  const seen = new Set<ProviderWorkKind>()
  for (const capability of input.work_capabilities) {
    if (
      !isRecord(capability) ||
      !hasOnly(capability, [
        'work_kind',
        'request_schema_versions',
        'result_schema_versions',
        'accepted_input_artifact_kinds',
        'produced_artifact_kinds',
        'model_recipe_namespaces',
        'hardware',
        'max_concurrency',
      ]) ||
      !validWorkKind(capability.work_kind) ||
      seen.has(capability.work_kind) ||
      !stringArray(capability.request_schema_versions, false) ||
      !stringArray(capability.result_schema_versions, false) ||
      !stringArray(capability.accepted_input_artifact_kinds) ||
      !stringArray(capability.produced_artifact_kinds) ||
      !stringArray(capability.model_recipe_namespaces) ||
      !Number.isInteger(capability.max_concurrency) ||
      Number(capability.max_concurrency) < 1 ||
      Number(capability.max_concurrency) > 64
    )
      throw new TypeError('invalid provider work capability')
    parseHardware(capability.hardware)
    seen.add(capability.work_kind)
  }
  return input as unknown as ProviderWorkCapabilities
}

function parseInputArtifact(input: unknown): ProviderInputArtifact {
  if (
    !isRecord(input) ||
    !hasOnly(input, [
      'artifact_id',
      'kind',
      'schema_version',
      'download_url',
      'download_url_expires_at',
      'sha256',
      'byte_length',
      'content_type',
    ]) ||
    !nonEmptyString(input.artifact_id) ||
    !nonEmptyString(input.kind) ||
    !nonEmptyString(input.schema_version, 32) ||
    !validUri(input.download_url) ||
    !validDate(input.download_url_expires_at) ||
    typeof input.sha256 !== 'string' ||
    !SHA256.test(input.sha256) ||
    typeof input.byte_length !== 'string' ||
    !UINT.test(input.byte_length) ||
    !nonEmptyString(input.content_type)
  )
    throw new TypeError('invalid provider input artifact')
  return input as unknown as ProviderInputArtifact
}

export function parseProviderWorkEnvelope(input: unknown): ProviderWorkEnvelope {
  if (
    !isRecord(input) ||
    !hasOnly(input, [
      'schema_version',
      'provider_job_id',
      'work_kind',
      'request_schema_version',
      'request_sha256',
      'idempotency_key',
      'input_artifacts',
      'request',
      'callback',
    ]) ||
    input.schema_version !== PROVIDER_WORK_ENVELOPE_VERSION ||
    !nonEmptyString(input.provider_job_id) ||
    !validWorkKind(input.work_kind) ||
    !nonEmptyString(input.request_schema_version, 32) ||
    typeof input.request_sha256 !== 'string' ||
    !SHA256.test(input.request_sha256) ||
    !nonEmptyString(input.idempotency_key) ||
    !Array.isArray(input.input_artifacts) ||
    !isRecord(input.request) ||
    input.request.schema_version !== input.request_schema_version ||
    input.request.provider_job_id !== input.provider_job_id ||
    !isRecord(input.callback)
  )
    throw new TypeError('invalid provider work envelope')
  input.input_artifacts.forEach(parseInputArtifact)
  if (
    !hasOnly(input.callback, ['url', 'token', 'expires_at', 'accepted_result_kinds']) ||
    !validUri(input.callback.url) ||
    typeof input.callback.token !== 'string' ||
    input.callback.token.length < 16 ||
    !validDate(input.callback.expires_at) ||
    !stringArray(input.callback.accepted_result_kinds, false)
  )
    throw new TypeError('invalid provider work callback')
  return input as unknown as ProviderWorkEnvelope
}

function parseActiveWork(input: unknown): ProviderActiveWork {
  if (
    !isRecord(input) ||
    !hasOnly(input, ['provider_job_id', 'work_kind', 'delivery_id'], ['progress']) ||
    !nonEmptyString(input.provider_job_id) ||
    !validWorkKind(input.work_kind) ||
    !nonEmptyString(input.delivery_id) ||
    (input.progress !== undefined && !validProgress(input.progress))
  )
    throw new TypeError('invalid active provider work')
  return input as unknown as ProviderActiveWork
}

function realtimeCommon(input: unknown) {
  if (
    !isRecord(input) ||
    input.schema_version !== PROVIDER_WORK_REALTIME_VERSION ||
    !nonEmptyString(input.type)
  )
    throw new TypeError('invalid provider work realtime message')
  return input
}

function validIdentity(value: Record<string, unknown>) {
  return (
    nonEmptyString(value.provider_job_id) &&
    validWorkKind(value.work_kind) &&
    nonEmptyString(value.delivery_id)
  )
}

export function parseProviderWorkClientMessage(input: unknown): ProviderWorkClientMessage {
  const value = realtimeCommon(input)
  switch (value.type) {
    case 'provider_hello':
      if (
        !hasOnly(value, [
          'schema_version',
          'type',
          'instance_id',
          'sdk_version',
          'provider_build_id',
          'capabilities',
          'active_work',
        ]) ||
        !nonEmptyString(value.instance_id) ||
        !nonEmptyString(value.sdk_version) ||
        !nonEmptyString(value.provider_build_id) ||
        !Array.isArray(value.active_work)
      )
        throw new TypeError('invalid provider work hello')
      parseProviderWorkCapabilities(value.capabilities)
      value.active_work.forEach(parseActiveWork)
      break
    case 'heartbeat':
    case 'resume_request':
      if (
        !hasOnly(value, ['schema_version', 'type', 'instance_id', 'active_work']) ||
        !nonEmptyString(value.instance_id) ||
        !Array.isArray(value.active_work)
      )
        throw new TypeError(`invalid ${String(value.type)}`)
      value.active_work.forEach(parseActiveWork)
      break
    case 'job_accepted':
      if (
        !hasOnly(value, [
          'schema_version',
          'type',
          'provider_job_id',
          'work_kind',
          'delivery_id',
          'accepted_at',
        ]) ||
        !validIdentity(value) ||
        !validDate(value.accepted_at)
      )
        throw new TypeError('invalid provider work acceptance')
      break
    case 'job_rejected':
    case 'job_failed':
      if (
        !hasOnly(value, [
          'schema_version',
          'type',
          'provider_job_id',
          'work_kind',
          'delivery_id',
          'code',
          'message',
          'retryable',
        ]) ||
        !validIdentity(value) ||
        !nonEmptyString(value.code) ||
        !nonEmptyString(value.message, 1000) ||
        typeof value.retryable !== 'boolean'
      )
        throw new TypeError(`invalid ${String(value.type)}`)
      break
    case 'progress':
      if (
        !hasOnly(
          value,
          ['schema_version', 'type', 'provider_job_id', 'work_kind', 'delivery_id', 'progress'],
          ['stage'],
        ) ||
        !validIdentity(value) ||
        !validProgress(value.progress) ||
        (value.stage !== undefined && value.stage !== null && typeof value.stage !== 'string')
      )
        throw new TypeError('invalid provider work progress')
      break
    case 'abort_ack':
      if (
        !hasOnly(value, [
          'schema_version',
          'type',
          'provider_job_id',
          'work_kind',
          'delivery_id',
          'acknowledged_at',
        ]) ||
        !validIdentity(value) ||
        !validDate(value.acknowledged_at)
      )
        throw new TypeError('invalid provider work abort acknowledgement')
      break
    default:
      throw new TypeError('unknown provider work client message')
  }
  return value as unknown as ProviderWorkClientMessage
}

export function parseProviderWorkServerMessage(input: unknown): ProviderWorkServerMessage {
  const value = realtimeCommon(input)
  switch (value.type) {
    case 'connection_ready':
      if (
        !hasOnly(value, [
          'schema_version',
          'type',
          'connection_id',
          'server_time',
          'heartbeat_interval_seconds',
          'lease_seconds',
        ]) ||
        !nonEmptyString(value.connection_id) ||
        !validDate(value.server_time) ||
        !Number.isInteger(value.heartbeat_interval_seconds) ||
        Number(value.heartbeat_interval_seconds) < 1 ||
        !Number.isInteger(value.lease_seconds) ||
        Number(value.lease_seconds) < 5
      )
        throw new TypeError('invalid provider work connection readiness')
      break
    case 'job_offer': {
      if (
        !hasOnly(value, [
          'schema_version',
          'type',
          'provider_job_id',
          'work_kind',
          'delivery_id',
          'lease_expires_at',
          'work',
        ]) ||
        !validIdentity(value) ||
        !validDate(value.lease_expires_at)
      )
        throw new TypeError('invalid provider work offer')
      const work = parseProviderWorkEnvelope(value.work)
      if (work.provider_job_id !== value.provider_job_id || work.work_kind !== value.work_kind)
        throw new TypeError('provider work offer passthrough mismatch')
      break
    }
    case 'lease_renewed':
    case 'resume_job':
      if (
        !hasOnly(value, [
          'schema_version',
          'type',
          'provider_job_id',
          'work_kind',
          'delivery_id',
          'lease_expires_at',
        ]) ||
        !validIdentity(value) ||
        !validDate(value.lease_expires_at)
      )
        throw new TypeError(`invalid ${String(value.type)}`)
      break
    case 'abort_job':
    case 'discard_job':
      if (
        !hasOnly(value, [
          'schema_version',
          'type',
          'provider_job_id',
          'work_kind',
          'delivery_id',
          'reason',
        ]) ||
        !validIdentity(value) ||
        !nonEmptyString(value.reason, 1000)
      )
        throw new TypeError(`invalid ${String(value.type)}`)
      break
    case 'job_committed':
      if (
        !hasOnly(value, [
          'schema_version',
          'type',
          'provider_job_id',
          'work_kind',
          'delivery_id',
          'committed_at',
        ]) ||
        !validIdentity(value) ||
        !validDate(value.committed_at)
      )
        throw new TypeError('invalid provider work commit')
      break
    case 'protocol_error':
      if (
        !hasOnly(value, ['schema_version', 'type', 'code', 'message', 'retryable']) ||
        !nonEmptyString(value.code) ||
        !nonEmptyString(value.message, 1000) ||
        typeof value.retryable !== 'boolean'
      )
        throw new TypeError('invalid provider work protocol error')
      break
    default:
      throw new TypeError('unknown provider work server message')
  }
  return value as unknown as ProviderWorkServerMessage
}
