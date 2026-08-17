import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { db as DatabaseClient } from '@volleyball-monitoring/db'

const ACTIVE_JOB_STATUSES = ['QUEUED', 'RUNNING'] as const
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._ -]{1,62}[\p{L}\p{N}]$/u

export interface AiWorkerAccessSnapshot {
  name: 'volleyball-analysis-engine'
  authMode: 'managed' | 'environment' | 'unconfigured'
  workerCount: number
  onlineWorkerCount: number
  activeJobCount: number
  tokens: AiWorkerTokenSnapshot[]
}

export interface AiWorkerTokenSnapshot {
  id: string
  name: string
  tokenPrefix: string
  enabled: boolean
  lastUsedAt: string | null
  createdAt: string
  updatedAt: string
}

export class AiWorkerAccessError extends Error {
  constructor(
    public readonly code: 'INVALID_NAME' | 'NOT_FOUND' | 'NAME_CONFLICT',
    message: string,
  ) {
    super(message)
  }
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const equal = (left: string, right: string) => {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function environmentToken(): string | undefined {
  return process.env.AI_PROVIDER_WS_TOKEN
}

function normalizeName(value: string): string {
  const name = value.trim().replace(/\s+/g, ' ')
  if (!NAME_PATTERN.test(name))
    throw new AiWorkerAccessError('INVALID_NAME', 'Token 名稱需為 3–64 個字元')
  return name
}

function freshToken() {
  return `vmai_${randomBytes(32).toString('base64url')}`
}

export async function authenticateAiWorkerToken(
  database: typeof DatabaseClient,
  presentedToken: string | undefined,
): Promise<boolean> {
  if (!presentedToken) return false
  const configured = environmentToken()
  if (configured && equal(sha256(presentedToken), sha256(configured))) return true

  const tokenHash = sha256(presentedToken)
  const updated = await database.aiWorkerAccessToken.updateMany({
    data: { lastUsedAt: new Date() },
    where: { enabled: true, tokenHash },
  })
  return updated.count === 1
}

export async function getAiWorkerAccess(
  database: typeof DatabaseClient,
  now = new Date(),
): Promise<AiWorkerAccessSnapshot> {
  const onlineAfter = new Date(now.getTime() - 30_000)
  const [tokens, workerCount, onlineWorkerCount, activeAiJobCount, activeProviderJobCount] =
    await Promise.all([
      database.aiWorkerAccessToken.findMany({
        orderBy: [{ enabled: 'desc' }, { createdAt: 'desc' }],
      }),
      database.aiProviderInstance.count(),
      database.aiProviderInstance.count({
        where: { disconnectedAt: null, lastSeenAt: { gte: onlineAfter } },
      }),
      database.aiJob.count({ where: { status: { in: [...ACTIVE_JOB_STATUSES] } } }),
      database.providerJob.count({ where: { status: { in: [...ACTIVE_JOB_STATUSES] } } }),
    ])
  return {
    activeJobCount: activeAiJobCount + activeProviderJobCount,
    authMode: tokens.length > 0 ? 'managed' : environmentToken() ? 'environment' : 'unconfigured',
    name: 'volleyball-analysis-engine',
    onlineWorkerCount,
    tokens: tokens.map(token => ({
      createdAt: token.createdAt.toISOString(),
      enabled: token.enabled,
      id: token.id,
      lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
      name: token.name,
      tokenPrefix: token.tokenPrefix,
      updatedAt: token.updatedAt.toISOString(),
    })),
    workerCount,
  }
}

export async function createAiWorkerToken(database: typeof DatabaseClient, rawName: string) {
  const name = normalizeName(rawName)
  const token = freshToken()
  try {
    const accessToken = await database.aiWorkerAccessToken.create({
      data: {
        name,
        tokenHash: sha256(token),
        tokenPrefix: token.slice(0, 12),
      },
      select: { id: true, name: true, tokenPrefix: true },
    })
    return { accessToken, token }
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') {
      throw new AiWorkerAccessError('NAME_CONFLICT', '已有相同名稱的 Worker Token')
    }
    throw error
  }
}

export async function rotateAiWorkerToken(database: typeof DatabaseClient, tokenId: string) {
  const token = freshToken()
  const updated = await database.aiWorkerAccessToken.updateMany({
    data: {
      enabled: true,
      lastUsedAt: null,
      tokenHash: sha256(token),
      tokenPrefix: token.slice(0, 12),
    },
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
  const updated = await database.aiWorkerAccessToken.updateMany({
    data: { enabled },
    where: { id: tokenId },
  })
  if (updated.count !== 1) throw new AiWorkerAccessError('NOT_FOUND', 'Worker Token 不存在')
  return { enabled, tokenId }
}

export async function deleteAiWorkerToken(database: typeof DatabaseClient, tokenId: string) {
  const deleted = await database.aiWorkerAccessToken.deleteMany({ where: { id: tokenId } })
  if (deleted.count !== 1) throw new AiWorkerAccessError('NOT_FOUND', 'Worker Token 不存在')
  return { tokenId }
}
