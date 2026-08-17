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
  status: JobStatus
  reason: string | null
  errorMessage: string | null
  createdAt: Date
  startedAt: Date | null
  completedAt: Date | null
}) => ({
  request_id: request.id,
  analysis_run_id: request.analysisRunId,
  status: request.status,
  reason: request.reason,
  error_message: request.errorMessage,
  reuses_feature_evidence: true,
  reuses_pose_evidence: true,
  created_at: request.createdAt.toISOString(),
  started_at: request.startedAt?.toISOString() ?? null,
  completed_at: request.completedAt?.toISOString() ?? null,
})

export async function requestReidAssociationRerun(
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
      submission: {
        select: {
          rally: {
            select: { matchId: true, match: { select: { identityRevision: true } } },
          },
        },
      },
      reidEvidenceSets: {
        where: { status: ArtifactState.READY, supersededAt: null, tracklets: { some: {} } },
        select: { id: true },
        take: 1,
      },
    },
  })
  if (!run) throw new GraphQLError('找不到分析版本', { extensions: { code: 'NOT_FOUND' } })
  if (run.reidEvidenceSets.length === 0)
    throw new GraphQLError('目前沒有可重新配對的 ReID feature evidence', {
      extensions: { code: 'BAD_USER_INPUT' },
    })
  const existing = await database.reidAssociationRerunRequest.findUnique({
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
  // Only one foreground/background rerun may be active for an analysis run. Identity revisions can
  // advance while an older provider job is still queued, so revision-only deduplication otherwise
  // creates another spinner target and another provider job on every click.
  const active = await database.reidAssociationRerunRequest.findFirst({
    where: {
      analysisRunId: input.analysisRunId,
      status: { in: [JobStatus.QUEUED, JobStatus.RUNNING] },
    },
    orderBy: { createdAt: 'desc' },
  })
  if (active) return { ...projection(active), match_id: run.submission.rally.matchId }
  const requestedIdentityRevision = run.submission.rally.match.identityRevision
  const sameRevision = await database.reidAssociationRerunRequest.findUnique({
    where: {
      analysisRunId_requestedIdentityRevision: {
        analysisRunId: input.analysisRunId,
        requestedIdentityRevision,
      },
    },
  })
  if (sameRevision) {
    const reusable =
      sameRevision.status === JobStatus.FAILED || sameRevision.status === JobStatus.CANCELLED
        ? await database.reidAssociationRerunRequest.update({
            where: { id: sameRevision.id },
            data: {
              status: JobStatus.QUEUED,
              requestedByUserId: input.userId,
              reason: input.reason?.trim().slice(0, 1_000) || null,
              errorMessage: null,
              startedAt: null,
              completedAt: null,
            },
          })
        : sameRevision
    return { ...projection(reusable), match_id: run.submission.rally.matchId }
  }
  let created
  try {
    created = await database.reidAssociationRerunRequest.create({
      data: {
        id: input.requestId,
        analysisRunId: input.analysisRunId,
        requestedByUserId: input.userId,
        requestedIdentityRevision,
        reason: input.reason?.trim().slice(0, 1_000) || null,
      },
    })
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'P2002'))
      throw error
    created = await database.reidAssociationRerunRequest.findUniqueOrThrow({
      where: {
        analysisRunId_requestedIdentityRevision: {
          analysisRunId: input.analysisRunId,
          requestedIdentityRevision,
        },
      },
    })
  }
  return { ...projection(created), match_id: run.submission.rally.matchId }
}

export async function getReidAssociationRerunRequest(
  database: PrismaClient,
  input: { requestId: string; role: UserRole },
) {
  assertEditorRole(input.role)
  const request = await database.reidAssociationRerunRequest.findUnique({
    where: { id: input.requestId },
  })
  return request ? projection(request) : null
}
