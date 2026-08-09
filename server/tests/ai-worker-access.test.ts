import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { authenticateAiIntegrationToken, createAiWorkerToken, resolveAiIntegrationForToken } from '../src/services/ai-worker-access.js'

const integration = { id: '20000000-0000-4000-8000-000000000001', authSecretRef: 'env:UNSET_AI_TOKEN' }

describe('AI worker access tokens', () => {
  it('authenticates a managed token by hash and records last use without storing plaintext', async () => {
    const presented = 'vmai_managed-token-long-enough'
    const tokenHash = createHash('sha256').update(presented).digest('hex')
    const findFirst = vi.fn(async () => ({ id: '40000000-0000-4000-8000-000000000001' }))
    const update = vi.fn(async () => ({}))
    const database = { aiIntegrationAccessToken: { findFirst, update } } as unknown as Parameters<typeof authenticateAiIntegrationToken>[0]

    await expect(authenticateAiIntegrationToken(database, integration, presented)).resolves.toBe(true)
    expect(findFirst).toHaveBeenCalledWith({
      select: { id: true },
      where: { enabled: true, integrationId: integration.id, tokenHash },
    })
    expect(update).toHaveBeenCalledWith({ data: { lastUsedAt: expect.any(Date) }, where: { id: '40000000-0000-4000-8000-000000000001' } })
  })

  it('resolves the internal integration from a globally unique managed token', async () => {
    const presented = 'vmai_route-by-token-long-enough'
    const resolved = {
      ...integration,
      enabled: true,
      jobSchemaVersion: '1.1.0',
      name: 'volleyball-analysis-engine',
      overlayFormat: 'flatbuffers_v1',
      resultSchemaVersion: '1.0.0',
      transportMode: 'WS_AGENT',
    }
    const findFirst = vi.fn(async () => ({
      id: '40000000-0000-4000-8000-000000000001',
      integration: resolved,
    }))
    const update = vi.fn(async () => ({}))
    const database = { aiIntegrationAccessToken: { findFirst, update } } as unknown as Parameters<typeof resolveAiIntegrationForToken>[0]

    await expect(resolveAiIntegrationForToken(database, presented)).resolves.toEqual(resolved)
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        enabled: true,
        tokenHash: createHash('sha256').update(presented).digest('hex'),
      }),
    }))
    expect(update).toHaveBeenCalledWith({
      data: { lastUsedAt: expect.any(Date) },
      where: { id: '40000000-0000-4000-8000-000000000001' },
    })
  })

  it('creates another credential for volleyball-analysis-engine', async () => {
    const findFirst = vi.fn(async () => ({ id: integration.id, name: 'Primary pool' }))
    const create = vi.fn(async ({ data }: { data: { integrationId: string; name: string; tokenHash: string; tokenPrefix: string } }) => ({
      id: '40000000-0000-4000-8000-000000000001',
      name: data.name,
      tokenPrefix: data.tokenPrefix,
    }))
    const database = {
      aiIntegration: { findFirst },
      aiIntegrationAccessToken: { create },
    } as unknown as Parameters<typeof createAiWorkerToken>[0]

    const result = await createAiWorkerToken(database, integration.id, 'GPU 工作站 A')
    expect(result.integration.id).toBe(integration.id)
    expect(result.token).toMatch(/^vmai_[A-Za-z0-9_-]{40,}$/)
    const persisted = create.mock.calls[0]![0].data
    expect(persisted.integrationId).toBe(integration.id)
    expect(persisted.tokenHash).toBe(createHash('sha256').update(result.token).digest('hex'))
    expect(JSON.stringify(persisted)).not.toContain(result.token)
  })
})
