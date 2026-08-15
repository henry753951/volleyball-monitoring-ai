import { describe, expect, it, vi } from 'vitest'
import { parse } from 'graphql'
import type { GraphQLRequestError } from './coreDomain'
import { CORE_OPERATIONS, createCoreDomainClient, createGraphQLTransport } from './coreDomain'

describe('core domain adapter', () => {
  it('keeps every hand-authored operation syntactically valid', () => {
    for (const operation of Object.values(CORE_OPERATIONS)) {
      expect(() => parse(operation)).not.toThrow()
    }
  })

  it('loads capture lifecycle with match list rows', async () => {
    const fetchImpl = vi.fn(async (_input, init) => {
      expect(JSON.parse(String(init?.body)).query).toContain('captureSessions')
      return new Response(
        JSON.stringify({
          data: {
            matches: [
              {
                id: 'm',
                title: 'M',
                venue: null,
                status: 'LIVE',
                scheduledAt: null,
                teams: [],
                rosterEntries: [],
                sets: [],
                captureSessions: [
                  {
                    id: 'c',
                    matchId: 'm',
                    sourceKind: 'youtube_vod',
                    sourceLabel: null,
                    sourceDurationUs: null,
                    status: 'FINISHED',
                    health: 'OFFLINE',
                    startedAt: null,
                    endedAt: null,
                  },
                ],
              },
            ],
          },
        }),
        { status: 200 },
      )
    })
    const result = await createCoreDomainClient(
      createGraphQLTransport('/graphql', fetchImpl as typeof fetch),
    ).matches()
    expect(result[0]?.captureSessions?.[0]?.status).toBe('FINISHED')
  })
  it('sends credentials and parses GraphQL data through the injected fetch', async () => {
    const fetchImpl = vi.fn(async (_input, init) => {
      expect(init?.credentials).toBe('include')
      return new Response(JSON.stringify({ data: { viewer: { id: 'u1', role: 'OPERATOR' } } }), {
        status: 200,
      })
    })
    const client = createCoreDomainClient(
      createGraphQLTransport('/graphql', fetchImpl as typeof fetch),
    )
    await expect(client.viewer()).resolves.toEqual({ id: 'u1', role: 'OPERATOR' })
  })

  it('exposes stable GraphQL error code and message', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            errors: [{ message: '需要登入', extensions: { code: 'UNAUTHENTICATED' } }],
          }),
          { status: 200 },
        ),
    )
    const client = createCoreDomainClient(
      createGraphQLTransport('/graphql', fetchImpl as typeof fetch),
    )
    await expect(client.viewer()).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      message: '需要登入',
    } satisfies Partial<GraphQLRequestError>)
  })

  it('updates a match roster through the generated GraphQL boundary', async () => {
    const fetchImpl = vi.fn(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        query: string
        variables: Record<string, unknown>
      }
      expect(request.query).toContain('updateMatchRoster')
      expect(request.variables).toEqual({
        input: {
          matchId: 'm1',
          teamId: 't1',
          roster: [{ id: 'r1', jerseyNumber: '8', name: 'Lin', position: 'OH' }],
        },
      })
      return new Response(
        JSON.stringify({
          data: {
            updateMatchRoster: {
              id: 'm1',
              title: 'M',
              venue: null,
              status: 'LIVE',
              scheduledAt: null,
              teams: [],
              rosterEntries: [],
              sets: [],
            },
          },
        }),
        { status: 200 },
      )
    })
    const client = createCoreDomainClient(
      createGraphQLTransport('/graphql', fetchImpl as typeof fetch),
    )
    await expect(
      client.updateMatchRoster({
        matchId: 'm1',
        teamId: 't1',
        roster: [{ id: 'r1', jerseyNumber: '8', name: 'Lin', position: 'OH' }],
      }),
    ).resolves.toMatchObject({ id: 'm1' })
  })
})
