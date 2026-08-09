import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { db as DatabaseClient } from '@volleyball-monitoring/db'

const ACTIVE_JOB_STATUSES = ['QUEUED', 'RUNNING'] as const
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._ -]{1,62}[\p{L}\p{N}]$/u

export interface AiIntegrationAccessSnapshot {
  id: string
  name: string
  enabled: boolean
  authMode: 'managed' | 'environment' | 'legacy'
  workerCount: number
  onlineWorkerCount: number
  activeJobCount: number
  createdAt: string
  updatedAt: string
  tokens: AiWorkerTokenSnapshot[]
}

export interface AiWorkerTokenSnapshot {
  id: string
  integrationId: string
  name: string
  tokenPrefix: string
  enabled: boolean
  lastUsedAt: string | null
  createdAt: string
  updatedAt: string
}

export class AiWorkerAccessError extends Error {
  constructor(public readonly code: 'INVALID_NAME' | 'NOT_FOUND' | 'NAME_CONFLICT', message: string) {
    super(message)
  }
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const equal = (left: string, right: string) => {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function environmentToken(authSecretRef: string): string | undefined {
  const referenced = authSecretRef.startsWith('env:') ? process.env[authSecretRef.slice(4)] : undefined
  return process.env.AI_PROVIDER_WS_TOKEN ?? referenced
}

function normalizeName(value: string): string {
  const name = value.trim().replace(/\s+/g, ' ')
  if (!NAME_PATTERN.test(name)) throw new AiWorkerAccessError('INVALID_NAME', 'Token 名稱需為 3–64 個字元')
  return name
}

function freshToken() {
  return `vmai_${randomBytes(32).toString('base64url')}`
}

export async function authenticateAiIntegrationToken(
  database: typeof DatabaseClient,
  integration: { id: string; authSecretRef: string },
  presentedToken: string | undefined,
): Promise<boolean> {
  if (!presentedToken) return false
  const configured = environmentToken(integration.authSecretRef)
  if (configured && equal(sha256(presentedToken), sha256(configured))) return true

  const tokenHash = sha256(presentedToken)
  const token = await database.aiIntegrationAccessToken.findFirst({
    select: { id: true },
    where: { enabled: true, integrationId: integration.id, tokenHash },
  })
  if (!token) return false
  await database.aiIntegrationAccessToken.update({
    data: { lastUsedAt: new Date() },
    where: { id: token.id },
  })
  return true
}

export async function listAiIntegrationAccess(
  database: typeof DatabaseClient,
  now = new Date(),
): Promise<AiIntegrationAccessSnapshot[]> {
  const onlineAfter = new Date(now.getTime() - 30_000)
  const integrations = await database.aiIntegration.findMany({
    orderBy: [{ enabled: 'desc' }, { updatedAt: 'desc' }],
    where: { transportMode: 'WS_AGENT' },
    select: {
      accessTokens: { orderBy: [{ enabled: 'desc' }, { createdAt: 'desc' }] },
      authSecretRef: true, createdAt: true, enabled: true, id: true, name: true, updatedAt: true,
      _count: {
        select: {
          jobs: { where: { status: { in: [...ACTIVE_JOB_STATUSES] } } },
          providerInstances: true,
        },
      },
      providerInstances: {
        select: { id: true },
        where: { disconnectedAt: null, lastSeenAt: { gte: onlineAfter } },
      },
    },
  })
  return integrations.map(integration => ({
    activeJobCount: integration._count.jobs,
    authMode: integration.accessTokens.length > 0
      ? 'managed'
      : integration.authSecretRef.startsWith('env:') ? 'environment' : 'legacy',
    createdAt: integration.createdAt.toISOString(),
    enabled: integration.enabled,
    id: integration.id,
    name: integration.name,
    onlineWorkerCount: integration.providerInstances.length,
    tokens: integration.accessTokens.map(token => ({
      createdAt: token.createdAt.toISOString(),
      enabled: token.enabled,
      id: token.id,
      integrationId: token.integrationId,
      lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
      name: token.name,
      tokenPrefix: token.tokenPrefix,
      updatedAt: token.updatedAt.toISOString(),
    })),
    updatedAt: integration.updatedAt.toISOString(),
    workerCount: integration._count.providerInstances,
  }))
}

export async function createAiWorkerToken(
  database: typeof DatabaseClient,
  integrationId: string,
  rawName: string,
) {
  const name = normalizeName(rawName)
  const token = freshToken()
  const integration = await database.aiIntegration.findFirst({
    select: { id: true, name: true },
    where: { enabled: true, id: integrationId, transportMode: 'WS_AGENT' },
  })
  if (!integration) throw new AiWorkerAccessError('NOT_FOUND', 'AI Worker Pool 不存在')
  try {
    const accessToken = await database.aiIntegrationAccessToken.create({
      data: {
        integrationId,
        name,
        tokenHash: sha256(token),
        tokenPrefix: token.slice(0, 12),
      },
      select: { id: true, name: true, tokenPrefix: true },
    })
    return { accessToken, integration, token }
  }
  catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') {
      throw new AiWorkerAccessError('NAME_CONFLICT', '此 Worker Pool 已有相同名稱的 Token')
    }
    throw error
  }
}

export async function rotateAiWorkerToken(database: typeof DatabaseClient, tokenId: string) {
  const token = freshToken()
  const updated = await database.aiIntegrationAccessToken.updateMany({
    data: { enabled: true, lastUsedAt: null, tokenHash: sha256(token), tokenPrefix: token.slice(0, 12) },
    where: { id: tokenId },
  })
  if (updated.count !== 1) throw new AiWorkerAccessError('NOT_FOUND', 'Worker Token 不存在')
  return { token, tokenId }
}

export async function setAiWorkerTokenEnabled(
  database: typeof DatabaseClient,
  tokenId: string,
  enabled: boolean,
) {
  const updated = await database.aiIntegrationAccessToken.updateMany({ data: { enabled }, where: { id: tokenId } })
  if (updated.count !== 1) throw new AiWorkerAccessError('NOT_FOUND', 'Worker Token 不存在')
  return { enabled, tokenId }
}
