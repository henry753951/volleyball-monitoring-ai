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
  position: RosterPosition
}

export type RosterPosition = 'UNSPECIFIED' | 'OH' | 'MB' | 'OPP' | 'S' | 'L' | 'DS'

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
  winningTeamId: string | null
  sideAssignments: CourtSideAssignment[]
}

export interface Match {
  id: string
  title: string
  venue: string | null
  status: string
  scheduledAt: string | null
  clipPreRollUs: string
  clipPostRollUs: string
  teams: Team[]
  rosterEntries: MatchRosterEntry[]
  sets: MatchSet[]
  captureSessions?: CaptureSession[]
}
export interface CaptureTimelineRange { startUs: string; endUs: string; discontinuity: number }
export interface CaptureTimeline { captureSessionId: string; captureStartTimeUs: string; liveEdgeCaptureTimeUs: string | null; timelineVersion: string; availableRanges: CaptureTimelineRange[]; availabilityComplete: boolean; gapRanges: CaptureTimelineRange[]; ingestFrontierCaptureTimeUs: string | null; sourceEndCaptureTimeUs: string | null }
export interface CaptureSession { id: string; matchId: string; sourceKind: string; sourceLabel: string | null; sourceDurationUs: string | null; status: string; health: string; startedAt: string | null; endedAt: string | null; timeline: CaptureTimeline | null }
export interface StartCaptureInput { matchId: string; ingestPath: string; sourceKind: string; sourceLabel?: string; sourceConfigSecretRef?: string }
export interface ProcessingState { rallyId: string; submissionId: string; status: string; retriedStage: 'clip' | 'ai' }

export interface RosterInput {
  name: string
  jerseyNumber: string
  position: RosterPosition
}

export interface RosterEditInput extends RosterInput {
  id?: string
}

export interface UpdateMatchRosterInput {
  matchId: string
  roster: RosterEditInput[]
  teamId: string
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

export interface UpdateMatchInput {
  matchId: string
  scheduledAt?: string | null
  status: string
  title: string
  venue?: string | null
}

export interface MatchDeleteReceipt {
  matchId: string
  removedAssetCount: number
  removedBytes: string
  cleanupWarnings: string[]
}

export interface SwapCourtSidesInput {
  setId: string
  effectiveFromRallyOrdinal: number
}

export interface UpdateMatchClipPolicyInput {
  matchId: string
  preRollSeconds: number
  postRollSeconds: number
}

export interface StartNextSetInput {
  matchId: string
  winningTeamId: string
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
  captureSession(id: string): Promise<CaptureSession | null>
  createMatchSetup(input: CreateMatchSetupInput): Promise<Match>
  deleteMatch(matchId: string): Promise<MatchDeleteReceipt>
  updateMatch(input: UpdateMatchInput): Promise<Match>
  updateMatchRoster(input: UpdateMatchRosterInput): Promise<Match>
  swapCourtSides(input: SwapCourtSidesInput): Promise<MatchSet>
  startCapture(input: StartCaptureInput): Promise<CaptureSession>
  stopCapture(captureSessionId: string): Promise<CaptureSession>
  retryProcessing(rallyId: string): Promise<ProcessingState>
  updateMatchClipPolicy(input: UpdateMatchClipPolicyInput): Promise<Match>
  startNextSet(input: StartNextSetInput): Promise<MatchSet>
}

export const CORE_OPERATIONS = {
  viewer: `query Viewer { viewer { id role } }`,
  matches: `query Matches { matches { id title venue status scheduledAt clipPreRollUs clipPostRollUs teams { id name shortName } rosterEntries { id teamId name jerseyNumber position } sets { id setNumber status leftScore rightScore winningTeamId sideAssignments { id effectiveFromRallyOrdinal effectiveToRallyOrdinal leftTeamId rightTeamId } } } }`,
  match: `query Match($id: ID!) { match(id: $id) { id title venue status scheduledAt clipPreRollUs clipPostRollUs teams { id name shortName } rosterEntries { id teamId name jerseyNumber position } sets { id setNumber status leftScore rightScore winningTeamId sideAssignments { id effectiveFromRallyOrdinal effectiveToRallyOrdinal leftTeamId rightTeamId } } captureSessions { id matchId sourceKind sourceLabel sourceDurationUs status health startedAt endedAt timeline { captureSessionId captureStartTimeUs liveEdgeCaptureTimeUs timelineVersion availabilityComplete ingestFrontierCaptureTimeUs sourceEndCaptureTimeUs availableRanges { startUs endUs discontinuity } gapRanges { startUs endUs discontinuity } } } } }`,
  captureSession: `query CaptureSession($id: ID!) { captureSession(id: $id) { id matchId sourceKind sourceLabel sourceDurationUs status health startedAt endedAt timeline { captureSessionId captureStartTimeUs liveEdgeCaptureTimeUs timelineVersion availabilityComplete ingestFrontierCaptureTimeUs sourceEndCaptureTimeUs availableRanges { startUs endUs discontinuity } gapRanges { startUs endUs discontinuity } } } }`,
  createMatchSetup: `mutation CreateMatchSetup($input: CreateMatchSetupInput!) { createMatchSetup(input: $input) { id title venue status scheduledAt clipPreRollUs clipPostRollUs teams { id name shortName } rosterEntries { id teamId name jerseyNumber position } sets { id setNumber status leftScore rightScore winningTeamId sideAssignments { id effectiveFromRallyOrdinal effectiveToRallyOrdinal leftTeamId rightTeamId } } } }`,
  deleteMatch: `mutation DeleteMatch($matchId: ID!) { deleteMatch(matchId: $matchId) { matchId removedAssetCount removedBytes cleanupWarnings } }`,
  updateMatch: `mutation UpdateMatch($input: UpdateMatchInput!) { updateMatch(input: $input) { id title venue status scheduledAt clipPreRollUs clipPostRollUs teams { id name shortName } rosterEntries { id teamId name jerseyNumber position } sets { id setNumber status leftScore rightScore winningTeamId sideAssignments { id effectiveFromRallyOrdinal effectiveToRallyOrdinal leftTeamId rightTeamId } } } }`,
  updateMatchRoster: `mutation UpdateMatchRoster($input: UpdateMatchRosterInput!) { updateMatchRoster(input: $input) { id title venue status scheduledAt clipPreRollUs clipPostRollUs teams { id name shortName } rosterEntries { id teamId name jerseyNumber position } sets { id setNumber status leftScore rightScore winningTeamId sideAssignments { id effectiveFromRallyOrdinal effectiveToRallyOrdinal leftTeamId rightTeamId } } } }`,
  swapCourtSides: `mutation SwapCourtSides($input: SwapCourtSidesInput!) { swapCourtSides(input: $input) { id setNumber status leftScore rightScore winningTeamId sideAssignments { id effectiveFromRallyOrdinal effectiveToRallyOrdinal leftTeamId rightTeamId } } }`,
  startCapture: `mutation StartCapture($input: StartCaptureInput!) { startCapture(input: $input) { id matchId sourceKind sourceLabel sourceDurationUs status health startedAt endedAt timeline { captureSessionId captureStartTimeUs liveEdgeCaptureTimeUs timelineVersion availabilityComplete ingestFrontierCaptureTimeUs sourceEndCaptureTimeUs availableRanges { startUs endUs discontinuity } gapRanges { startUs endUs discontinuity } } } }`,
  stopCapture: `mutation StopCapture($captureSessionId: ID!) { stopCapture(captureSessionId: $captureSessionId) { id matchId sourceKind sourceLabel sourceDurationUs status health startedAt endedAt timeline { captureSessionId captureStartTimeUs liveEdgeCaptureTimeUs timelineVersion availabilityComplete ingestFrontierCaptureTimeUs sourceEndCaptureTimeUs availableRanges { startUs endUs discontinuity } gapRanges { startUs endUs discontinuity } } } }`,
  retryProcessing: `mutation RetryProcessing($input: RetryProcessingInput!) { retryProcessing(input: $input) { rallyId submissionId status retriedStage } }`,
  updateMatchClipPolicy: `mutation UpdateMatchClipPolicy($input: UpdateMatchClipPolicyInput!) { updateMatchClipPolicy(input: $input) { id title venue status scheduledAt clipPreRollUs clipPostRollUs teams { id name shortName } rosterEntries { id teamId name jerseyNumber position } sets { id setNumber status leftScore rightScore winningTeamId sideAssignments { id effectiveFromRallyOrdinal effectiveToRallyOrdinal leftTeamId rightTeamId } } } }`,
  startNextSet: `mutation StartNextSet($input: StartNextSetInput!) { startNextSet(input: $input) { id setNumber status leftScore rightScore winningTeamId sideAssignments { id effectiveFromRallyOrdinal effectiveToRallyOrdinal leftTeamId rightTeamId } } }`,
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
    async captureSession(id) {
      const result = await transport.request<{ captureSession: CaptureSession | null }>(CORE_OPERATIONS.captureSession, { id })
      return result.captureSession
    },
    async createMatchSetup(input) {
      const result = await transport.request<{ createMatchSetup: Match }>(CORE_OPERATIONS.createMatchSetup, { input })
      return result.createMatchSetup
    },
    async deleteMatch(matchId) {
      const result = await transport.request<{ deleteMatch: MatchDeleteReceipt }>(CORE_OPERATIONS.deleteMatch, { matchId })
      return result.deleteMatch
    },
    async updateMatch(input) {
      const result = await transport.request<{ updateMatch: Match }>(CORE_OPERATIONS.updateMatch, { input })
      return result.updateMatch
    },
    async updateMatchRoster(input) {
      const result = await transport.request<{ updateMatchRoster: Match }>(CORE_OPERATIONS.updateMatchRoster, { input })
      return result.updateMatchRoster
    },
    async swapCourtSides(input) {
      const result = await transport.request<{ swapCourtSides: MatchSet }>(CORE_OPERATIONS.swapCourtSides, { input })
      return result.swapCourtSides
    },
    async startCapture(input) {
      const result = await transport.request<{ startCapture: CaptureSession }>(CORE_OPERATIONS.startCapture, { input })
      return result.startCapture
    },
    async stopCapture(captureSessionId) {
      const result = await transport.request<{ stopCapture: CaptureSession }>(CORE_OPERATIONS.stopCapture, { captureSessionId })
      return result.stopCapture
    },
    async retryProcessing(rallyId) {
      const result = await transport.request<{ retryProcessing: ProcessingState }>(CORE_OPERATIONS.retryProcessing, { input: { rallyId } })
      return result.retryProcessing
    },
    async updateMatchClipPolicy(input) {
      const result = await transport.request<{ updateMatchClipPolicy: Match }>(CORE_OPERATIONS.updateMatchClipPolicy, { input })
      return result.updateMatchClipPolicy
    },
    async startNextSet(input) {
      const result = await transport.request<{ startNextSet: MatchSet }>(CORE_OPERATIONS.startNextSet, { input })
      return result.startNextSet
    },
  }
}
