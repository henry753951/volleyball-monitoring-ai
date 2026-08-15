export const AI_PROVIDER_REALTIME_VERSION = '1.0.0' as const

export interface AIProviderCapabilitiesPayload {
  schema_version: '2.0.0'
  provider_name: string
  provider_build_id: string
  supported_job_schema_versions: string[]
  supported_analysis_data_versions: string[]
  supported_analysis_modules: Array<'court' | 'tracking' | 'reid' | 'contacts'>
  supports_selective_rerun: boolean
  optional_extensions: Record<string, boolean>
  action_taxonomies: unknown[]
  [key: string]: unknown
}

export interface AIProviderActiveJob {
  ai_job_id: string
  delivery_id: string
  progress?: number
}

export type AIProviderClientMessage =
  | {
      schema_version: '1.0.0'
      type: 'provider_hello'
      instance_id: string
      sdk_version: string
      provider_build_id: string
      max_concurrency: number
      capabilities: AIProviderCapabilitiesPayload
      active_jobs: AIProviderActiveJob[]
    }
  | {
      schema_version: '1.0.0'
      type: 'job_accepted'
      ai_job_id: string
      delivery_id: string
      accepted_at: string
    }
  | {
      schema_version: '1.0.0'
      type: 'job_rejected'
      ai_job_id: string
      delivery_id: string
      code: string
      message: string
      retryable: boolean
    }
  | {
      schema_version: '1.0.0'
      type: 'heartbeat'
      instance_id: string
      active_jobs: AIProviderActiveJob[]
    }
  | {
      schema_version: '1.0.0'
      type: 'progress'
      ai_job_id: string
      delivery_id: string
      progress: number
      stage?: string | null
    }
  | {
      schema_version: '1.0.0'
      type: 'abort_ack'
      ai_job_id: string
      delivery_id: string
      acknowledged_at: string
    }
  | {
      schema_version: '1.0.0'
      type: 'job_failed'
      ai_job_id: string
      delivery_id: string
      code: string
      message: string
      retryable: boolean
    }
  | {
      schema_version: '1.0.0'
      type: 'resume_request'
      instance_id: string
      active_jobs: AIProviderActiveJob[]
    }

export type AIProviderServerMessage =
  | {
      schema_version: '1.0.0'
      type: 'connection_ready'
      connection_id: string
      server_time: string
      heartbeat_interval_seconds: number
      lease_seconds: number
    }
  | {
      schema_version: '1.0.0'
      type: 'job_offer'
      ai_job_id: string
      delivery_id: string
      lease_expires_at: string
      job: Record<string, unknown>
    }
  | {
      schema_version: '1.0.0'
      type: 'lease_renewed'
      ai_job_id: string
      delivery_id: string
      lease_expires_at: string
    }
  | {
      schema_version: '1.0.0'
      type: 'abort_job'
      ai_job_id: string
      delivery_id: string
      reason: string
    }
  | {
      schema_version: '1.0.0'
      type: 'resume_job'
      ai_job_id: string
      delivery_id: string
      lease_expires_at: string
    }
  | {
      schema_version: '1.0.0'
      type: 'discard_job'
      ai_job_id: string
      delivery_id: string
      reason: string
    }
  | {
      schema_version: '1.0.0'
      type: 'job_committed'
      ai_job_id: string
      delivery_id: string
      committed_at: string
    }
  | {
      schema_version: '1.0.0'
      type: 'protocol_error'
      code: string
      message: string
      retryable: boolean
    }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const hasOnly = (value: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every(key => key in value) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key))
const stringField = (value: Record<string, unknown>, key: string) =>
  typeof value[key] === 'string' && String(value[key]).length > 0
const validDate = (value: unknown) => typeof value === 'string' && !Number.isNaN(Date.parse(value))
const validProgress = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
const stringArray = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(item => typeof item === 'string' && item.length > 0)
const validCapabilities = (value: unknown): value is AIProviderCapabilitiesPayload =>
  isRecord(value) &&
  value.schema_version === '2.0.0' &&
  stringField(value, 'provider_name') &&
  stringField(value, 'provider_build_id') &&
  stringArray(value.supported_job_schema_versions) &&
  stringArray(value.supported_analysis_data_versions) &&
  stringArray(value.supported_analysis_modules) &&
  value.supported_analysis_modules.every(module =>
    ['court', 'tracking', 'reid', 'contacts'].includes(module),
  ) &&
  typeof value.supports_selective_rerun === 'boolean' &&
  isRecord(value.optional_extensions) &&
  Object.values(value.optional_extensions).every(flag => typeof flag === 'boolean') &&
  Array.isArray(value.action_taxonomies)
const validActiveJobs = (value: unknown): value is AIProviderActiveJob[] =>
  Array.isArray(value) &&
  value.every(
    job =>
      isRecord(job) &&
      hasOnly(job, ['ai_job_id', 'delivery_id'], ['progress']) &&
      stringField(job, 'ai_job_id') &&
      stringField(job, 'delivery_id') &&
      (job.progress === undefined || validProgress(job.progress)),
  )

function common(input: unknown): Record<string, unknown> {
  if (
    !isRecord(input) ||
    input.schema_version !== AI_PROVIDER_REALTIME_VERSION ||
    !stringField(input, 'type')
  )
    throw new TypeError('invalid AI provider realtime message')
  return input
}

export function parseAIProviderClientMessage(input: unknown): AIProviderClientMessage {
  const value = common(input)
  switch (value.type) {
    case 'provider_hello': {
      if (
        !hasOnly(value, [
          'schema_version',
          'type',
          'instance_id',
          'sdk_version',
          'provider_build_id',
          'max_concurrency',
          'capabilities',
          'active_jobs',
        ]) ||
        !stringField(value, 'instance_id') ||
        !stringField(value, 'sdk_version') ||
        !stringField(value, 'provider_build_id') ||
        typeof value.max_concurrency !== 'number' ||
        !Number.isInteger(value.max_concurrency) ||
        value.max_concurrency < 1 ||
        value.max_concurrency > 64 ||
        !validCapabilities(value.capabilities) ||
        !validActiveJobs(value.active_jobs)
      )
        throw new TypeError('invalid provider_hello')
      return value as unknown as AIProviderClientMessage
    }
    case 'job_accepted':
      if (
        !hasOnly(value, ['schema_version', 'type', 'ai_job_id', 'delivery_id', 'accepted_at']) ||
        !stringField(value, 'ai_job_id') ||
        !stringField(value, 'delivery_id') ||
        !validDate(value.accepted_at)
      )
        throw new TypeError('invalid job_accepted')
      return value as unknown as AIProviderClientMessage
    case 'job_rejected':
    case 'job_failed':
      if (
        !hasOnly(value, [
          'schema_version',
          'type',
          'ai_job_id',
          'delivery_id',
          'code',
          'message',
          'retryable',
        ]) ||
        !stringField(value, 'ai_job_id') ||
        !stringField(value, 'delivery_id') ||
        !stringField(value, 'code') ||
        !stringField(value, 'message') ||
        typeof value.retryable !== 'boolean'
      )
        throw new TypeError(`invalid ${value.type}`)
      return value as unknown as AIProviderClientMessage
    case 'heartbeat':
    case 'resume_request':
      if (
        !hasOnly(value, ['schema_version', 'type', 'instance_id', 'active_jobs']) ||
        !stringField(value, 'instance_id') ||
        !validActiveJobs(value.active_jobs)
      )
        throw new TypeError(`invalid ${value.type}`)
      return value as unknown as AIProviderClientMessage
    case 'progress':
      if (
        !hasOnly(
          value,
          ['schema_version', 'type', 'ai_job_id', 'delivery_id', 'progress'],
          ['stage'],
        ) ||
        !stringField(value, 'ai_job_id') ||
        !stringField(value, 'delivery_id') ||
        !validProgress(value.progress) ||
        (value.stage !== undefined && value.stage !== null && typeof value.stage !== 'string')
      )
        throw new TypeError('invalid progress')
      return value as unknown as AIProviderClientMessage
    case 'abort_ack':
      if (
        !hasOnly(value, [
          'schema_version',
          'type',
          'ai_job_id',
          'delivery_id',
          'acknowledged_at',
        ]) ||
        !stringField(value, 'ai_job_id') ||
        !stringField(value, 'delivery_id') ||
        !validDate(value.acknowledged_at)
      )
        throw new TypeError('invalid abort_ack')
      return value as unknown as AIProviderClientMessage
    default:
      throw new TypeError('unknown AI provider client message')
  }
}

export function parseAIProviderServerMessage(input: unknown): AIProviderServerMessage {
  const value = common(input)
  const identity = () => stringField(value, 'ai_job_id') && stringField(value, 'delivery_id')
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
        !stringField(value, 'connection_id') ||
        !validDate(value.server_time) ||
        !Number.isInteger(value.heartbeat_interval_seconds) ||
        Number(value.heartbeat_interval_seconds) < 1 ||
        !Number.isInteger(value.lease_seconds) ||
        Number(value.lease_seconds) < 5
      )
        throw new TypeError('invalid connection_ready')
      break
    case 'job_offer':
      if (
        !hasOnly(value, [
          'schema_version',
          'type',
          'ai_job_id',
          'delivery_id',
          'lease_expires_at',
          'job',
        ]) ||
        !identity() ||
        !validDate(value.lease_expires_at) ||
        !isRecord(value.job) ||
        value.job.schema_version !== '3.0.0' ||
        value.job.ai_job_id !== value.ai_job_id
      )
        throw new TypeError('invalid job_offer')
      break
    case 'lease_renewed':
    case 'resume_job':
      if (
        !hasOnly(value, [
          'schema_version',
          'type',
          'ai_job_id',
          'delivery_id',
          'lease_expires_at',
        ]) ||
        !identity() ||
        !validDate(value.lease_expires_at)
      )
        throw new TypeError(`invalid ${value.type}`)
      break
    case 'abort_job':
    case 'discard_job':
      if (
        !hasOnly(value, ['schema_version', 'type', 'ai_job_id', 'delivery_id', 'reason']) ||
        !identity() ||
        !stringField(value, 'reason')
      )
        throw new TypeError(`invalid ${value.type}`)
      break
    case 'job_committed':
      if (
        !hasOnly(value, ['schema_version', 'type', 'ai_job_id', 'delivery_id', 'committed_at']) ||
        !identity() ||
        !validDate(value.committed_at)
      )
        throw new TypeError('invalid job_committed')
      break
    case 'protocol_error':
      if (
        !hasOnly(value, ['schema_version', 'type', 'code', 'message', 'retryable']) ||
        !stringField(value, 'code') ||
        !stringField(value, 'message') ||
        typeof value.retryable !== 'boolean'
      )
        throw new TypeError('invalid protocol_error')
      break
    default:
      throw new TypeError('unknown AI provider server message')
  }
  return value as unknown as AIProviderServerMessage
}
