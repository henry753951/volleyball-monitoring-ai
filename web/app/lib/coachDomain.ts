import type { GraphQLTransport } from './coreDomain'

export interface CoachTeam { id: string; name: string; shortName: string }
export interface CoachSideAssignment { id: string; left_team_id: string; right_team_id: string }
export interface CoachSet {
  id: string
  set_number: number
  status: string
  left_score: number
  right_score: number
  score_revision: number
  side_assignment: CoachSideAssignment | null
}
export interface CoachCapture { id: string; source_label: string | null; status: string; health: string }
export interface CoachRally {
  id: string
  ordinal: number
  annotation_revision: string
  processing_status: string
  scoring_court_side: string | null
  scoring_team_id: string | null
  set_id: string
  set_number: number
  submission: {
    id: string
    submitted_at: string
    score_resolution: string
    scoring_court_side: string | null
    scoring_team_id: string | null
    clip: { id: string; status: string } | null
    analysis: { id: string; status: string; version: string; summary: unknown } | null
  }
}
export interface CoachMatchState {
  schema_version: '1.0.0'
  match: {
    id: string
    title: string
    status: string
    teams: CoachTeam[]
    sets: CoachSet[]
    captures: CoachCapture[]
    rallies: CoachRally[]
  }
}

const COACH_MATCH_STATE = `query CoachMatchState($matchId: ID!) { coachMatchState(matchId: $matchId) }`

export function createCoachDomainClient(transport: GraphQLTransport) {
  return {
    async matchState(matchId: string) {
      const result = await transport.request<{ coachMatchState: CoachMatchState | null }>(COACH_MATCH_STATE, { matchId })
      return result.coachMatchState
    },
  }
}
