import { describe, expect, it, vi } from 'vitest'
import { createCoreDomainClient, createGraphQLTransport, GraphQLRequestError } from './coreDomain'

describe('core domain adapter', () => {
  it('accepts list/setup match shapes without captureSessions while detail may include them', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: { matches: [{ id: 'm', title: 'M', venue: null, status: 'LIVE', scheduledAt: null, teams: [], rosterEntries: [], sets: [] }] } }), { status: 200 }))
    const result = await createCoreDomainClient(createGraphQLTransport('/graphql', fetchImpl as typeof fetch)).matches()
    expect(result[0]?.captureSessions).toBeUndefined()
  })
  it('sends credentials and parses GraphQL data through the injected fetch', async () => {
    const fetchImpl = vi.fn(async (_input, init) => {
      expect(init?.credentials).toBe('include')
      return new Response(JSON.stringify({ data: { viewer: { id: 'u1', role: 'OPERATOR' } } }), { status: 200 })
    })
    const client = createCoreDomainClient(createGraphQLTransport('/graphql', fetchImpl as typeof fetch))
    await expect(client.viewer()).resolves.toEqual({ id: 'u1', role: 'OPERATOR' })
  })

  it('exposes stable GraphQL error code and message', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: '需要登入', extensions: { code: 'UNAUTHENTICATED' } }] }), { status: 200 }))
    const client = createCoreDomainClient(createGraphQLTransport('/graphql', fetchImpl as typeof fetch))
    await expect(client.viewer()).rejects.toMatchObject({ code: 'UNAUTHENTICATED', message: '需要登入' } satisfies Partial<GraphQLRequestError>)
  })
})
