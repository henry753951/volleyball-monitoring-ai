import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  authenticateAiWorkerToken,
  createAiWorkerToken,
  deleteAiWorkerToken,
  getAiWorkerAccess,
} from '../src/services/ai-worker-access.js'

afterEach(() => {
  delete process.env.AI_PROVIDER_WS_TOKEN
})

describe('AI worker access tokens', () => {
  it('authenticates a global managed token by hash and records last use', async () => {
    const presented = 'vmai_managed-token-long-enough'
    const tokenHash = createHash('sha256').update(presented).digest('hex')
    const updateMany = vi.fn(async () => ({ count: 1 }))
    const database = { aiWorkerAccessToken: { updateMany } } as unknown as Parameters<
      typeof authenticateAiWorkerToken
    >[0]

    await expect(authenticateAiWorkerToken(database, presented)).resolves.toBe(true)
    expect(updateMany).toHaveBeenCalledWith({
      data: { lastUsedAt: expect.any(Date) },
      where: { enabled: true, tokenHash },
    })
  })

  it('accepts the deployment token without a database provider record', async () => {
    process.env.AI_PROVIDER_WS_TOKEN = 'environment-worker-token-long-enough'
    const database = { aiWorkerAccessToken: { findFirst: vi.fn() } } as unknown as Parameters<
      typeof authenticateAiWorkerToken
    >[0]
    await expect(
      authenticateAiWorkerToken(database, process.env.AI_PROVIDER_WS_TOKEN),
    ).resolves.toBe(true)
  })

  it('creates a global credential for volleyball-analysis-engine', async () => {
    const create = vi.fn(
      async ({ data }: { data: { name: string; tokenHash: string; tokenPrefix: string } }) => ({
        id: '40000000-0000-4000-8000-000000000001',
        name: data.name,
        tokenPrefix: data.tokenPrefix,
      }),
    )
    const database = { aiWorkerAccessToken: { create } } as unknown as Parameters<
      typeof createAiWorkerToken
    >[0]

    const result = await createAiWorkerToken(database, 'GPU 工作站 A')
    expect(result.token).toMatch(/^vmai_[A-Za-z0-9_-]{40,}$/)
    const persisted = create.mock.calls[0]![0].data
    expect(persisted.tokenHash).toBe(createHash('sha256').update(result.token).digest('hex'))
    expect(JSON.stringify(persisted)).not.toContain(result.token)
  })

  it('permanently deletes a managed token', async () => {
    const deleteMany = vi.fn(async () => ({ count: 1 }))
    const database = { aiWorkerAccessToken: { deleteMany } } as unknown as Parameters<
      typeof deleteAiWorkerToken
    >[0]

    await expect(
      deleteAiWorkerToken(database, '40000000-0000-4000-8000-000000000001'),
    ).resolves.toEqual({
      tokenId: '40000000-0000-4000-8000-000000000001',
    })
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: '40000000-0000-4000-8000-000000000001' },
    })
  })

  it('summarizes the single engine directly from tokens, workers, and jobs', async () => {
    const database = {
      aiWorkerAccessToken: { findMany: vi.fn(async () => []) },
      aiProviderInstance: { count: vi.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(1) },
      aiJob: { count: vi.fn(async () => 3) },
      providerJob: { count: vi.fn(async () => 2) },
    } as unknown as Parameters<typeof getAiWorkerAccess>[0]
    await expect(getAiWorkerAccess(database)).resolves.toMatchObject({
      activeJobCount: 5,
      authMode: 'unconfigured',
      name: 'volleyball-analysis-engine',
      onlineWorkerCount: 1,
      tokens: [],
      workerCount: 2,
    })
  })
})
