export interface Viewer {
  id: string
  role: string
}

export interface Team {
  id: string
  name: string
  shortName: string
}

export interface MatchRosterEntry {
  id: string
  teamId: string
  name: string
  jerseyNumber: string
}

export interface CourtSideAssignment {
  id: string
  effectiveFromRallyOrdinal: number
  effectiveToRallyOrdinal: number | null
  leftTeamId: string
  rightTeamId: string
}

export interface MatchSet {
  id: string
  setNumber: number
  status: string
  leftScore: number
  rightScore: number
  sideAssignments: CourtSideAssignment[]
}

export interface Match {
  id: string
  title: string
  venue: string | null
  status: string
  scheduledAt: string | null
  teams: Team[]
  rosterEntries: MatchRosterEntry[]
  sets: MatchSet[]
}

export interface RosterInput {
  name: string
  jerseyNumber: string
}

export interface TeamSetupInput {
  name: string
  shortName: string
  roster: RosterInput[]
}

export interface CreateMatchSetupInput {
  title: string
  venue?: string
  scheduledAt?: string
  leftTeam: TeamSetupInput
  rightTeam: TeamSetupInput
}

export interface SwapCourtSidesInput {
  setId: string
  effectiveFromRallyOrdinal: number
}

export interface GraphQLErrorLike {
  message: string
  extensions?: { code?: string }
}

export class GraphQLRequestError extends Error {
  readonly code: string | undefined
  readonly details: GraphQLErrorLike[]

  constructor(details: GraphQLErrorLike[]) {
    super(details[0]?.message ?? 'GraphQL 請求失敗')
    this.name = 'GraphQLRequestError'
    this.code = details[0]?.extensions?.code
    this.details = details
  }
}

export interface GraphQLTransport {
  request<T>(query: string, variables?: Record<string, unknown>): Promise<T>
}

export interface CoreDomainClient {
  viewer(): Promise<Viewer | null>
  matches(): Promise<Match[]>
  match(id: string): Promise<Match | null>
  createMatchSetup(input: CreateMatchSetupInput): Promise<Match>
  swapCourtSides(input: SwapCourtSidesInput): Promise<MatchSet>
}

export const CORE_OPERATIONS = {
  viewer: `query Viewer { viewer { id role } }`,
  matches: `query Matches { matches { id title venue status scheduledAt teams { id name shortName } rosterEntries { id teamId name jerseyNumber } sets { id setNumber status leftScore rightScore sideAssignments { id effectiveFromRallyOrdinal effectiveToRallyOrdinal leftTeamId rightTeamId } } } }`,
  match: `query Match($id: ID!) { match(id: $id) { id title venue status scheduledAt teams { id name shortName } rosterEntries { id teamId name jerseyNumber } sets { id setNumber status leftScore rightScore sideAssignments { id effectiveFromRallyOrdinal effectiveToRallyOrdinal leftTeamId rightTeamId } } } }`,
  createMatchSetup: `mutation CreateMatchSetup($input: CreateMatchSetupInput!) { createMatchSetup(input: $input) { id title venue status scheduledAt teams { id name shortName } rosterEntries { id teamId name jerseyNumber } sets { id setNumber status leftScore rightScore sideAssignments { id effectiveFromRallyOrdinal effectiveToRallyOrdinal leftTeamId rightTeamId } } } }`,
  swapCourtSides: `mutation SwapCourtSides($input: SwapCourtSidesInput!) { swapCourtSides(input: $input) { id setNumber status leftScore rightScore sideAssignments { id effectiveFromRallyOrdinal effectiveToRallyOrdinal leftTeamId rightTeamId } } }`,
} as const

export function createGraphQLTransport(
  endpoint: string,
  fetchImpl: typeof fetch = fetch,
): GraphQLTransport {
  return {
    async request<T>(query: string, variables?: Record<string, unknown>) {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      })
      const payload = await response.json() as { data?: T; errors?: GraphQLErrorLike[] }
      if (!response.ok || payload.errors?.length) {
        throw new GraphQLRequestError(payload.errors?.length ? payload.errors : [{ message: `GraphQL HTTP ${response.status}` }])
      }
      return payload.data as T
    },
  }
}

export function createCoreDomainClient(transport: GraphQLTransport): CoreDomainClient {
  return {
    async viewer() {
      const result = await transport.request<{ viewer: Viewer | null }>(CORE_OPERATIONS.viewer)
      return result.viewer
    },
    async matches() {
      const result = await transport.request<{ matches: Match[] }>(CORE_OPERATIONS.matches)
      return result.matches
    },
    async match(id) {
      const result = await transport.request<{ match: Match | null }>(CORE_OPERATIONS.match, { id })
      return result.match
    },
    async createMatchSetup(input) {
      const result = await transport.request<{ createMatchSetup: Match }>(CORE_OPERATIONS.createMatchSetup, { input })
      return result.createMatchSetup
    },
    async swapCourtSides(input) {
      const result = await transport.request<{ swapCourtSides: MatchSet }>(CORE_OPERATIONS.swapCourtSides, { input })
      return result.swapCourtSides
    },
  }
}
