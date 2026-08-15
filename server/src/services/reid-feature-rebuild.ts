import type { PrismaClient } from '@volleyball-monitoring/db'
import { ArtifactState, JobStatus, UserRole } from '@volleyball-monitoring/db/client'
import { GraphQLError } from 'graphql'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function assertEditorRole(role: UserRole) {
  if (role !== UserRole.ADMIN && role !== UserRole.OPERATOR && role !== UserRole.COACH)
    throw new Error('FORBIDDEN')
}

const projection = (request: {
  id: string
  analysisRunId: string
  providerJobId: string | null
  status: JobStatus
  reason: string | null
  errorMessage: string | null
  createdAt: Date
  startedAt: Date | null
  completedAt: Date | null
}) => ({
  request_id: request.id,
  analysis_run_id: request.analysisRunId,
  provider_job_id: request.providerJobId,
  status: request.status,
  reason: request.reason,
  error_message: request.errorMessage,
  pose_reused: true,
  created_at: request.createdAt.toISOString(),
  started_at: request.startedAt?.toISOString() ?? null,
  completed_at: request.completedAt?.toISOString() ?? null,
})

export async function requestReidFeatureRebuild(
  database: PrismaClient,
  input: {
    requestId: string
    analysisRunId: string
    reason?: string | null | undefined
    userId: string
    role: UserRole
  },
) {
  assertEditorRole(input.role)
  if (!UUID_PATTERN.test(input.requestId))
    throw new GraphQLError('requestId 必須是 UUID', { extensions: { code: 'BAD_USER_INPUT' } })
  const run = await database.analysisRun.findUnique({
    where: { id: input.analysisRunId },
    select: {
      submission: { select: { rally: { select: { matchId: true } } } },
      analysisEvidenceBundle: { select: { status: true } },
      reidEvidenceSets: {
        where: { status: ArtifactState.READY, supersededAt: null },
        select: { id: true },
        take: 1,
      },
    },
  })
  if (!run) throw new GraphQLError('找不到分析版本', { extensions: { code: 'NOT_FOUND' } })
  if (
    run.analysisEvidenceBundle?.status !== ArtifactState.READY ||
    run.reidEvidenceSets.length === 0
  )
    throw new GraphQLError('目前沒有可安全取代的 ReID evidence generation', {
      extensions: { code: 'BAD_USER_INPUT' },
    })
  const existing = await database.reidFeatureRebuildRequest.findUnique({
    where: { id: input.requestId },
  })
  if (existing) {
    if (
      existing.analysisRunId !== input.analysisRunId ||
      existing.requestedByUserId !== input.userId
    )
      throw new GraphQLError('requestId 已被其他請求使用', {
        extensions: { code: 'CONFLICT' },
      })
    return { ...projection(existing), match_id: run.submission.rally.matchId }
  }
  const created = await database.reidFeatureRebuildRequest.create({
    data: {
      id: input.requestId,
      analysisRunId: input.analysisRunId,
      requestedByUserId: input.userId,
      reason: input.reason?.trim().slice(0, 1_000) || null,
    },
  })
  return { ...projection(created), match_id: run.submission.rally.matchId }
}

export async function getReidFeatureRebuildRequest(
  database: PrismaClient,
  input: { requestId: string; role: UserRole },
) {
  assertEditorRole(input.role)
  const request = await database.reidFeatureRebuildRequest.findUnique({
    where: { id: input.requestId },
  })
  return request ? projection(request) : null
}
