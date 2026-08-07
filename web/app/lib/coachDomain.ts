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

export interface ReplayCourtPosition { track_id: number | null; basis: string; court_pos: { x: number; y: number }; confidence: number | null }
export interface ReplayActor { track_id: number; observation_frame_index: string; association_confidence: number | null; frame_bbox: { x1: number; y1: number; x2: number; y2: number } | null; frame_foot_pos: { x: number; y: number } | null; court_pos: { x: number; y: number } | null; action: unknown }
export interface ReplayContactEvent { key_point_id: string; sequence_index: number; marker_kind: string; is_terminal: boolean; anchor_frame_index: string; resolved_frame_index: string | null; anchor_time_us: string; association_state: string; ball: { state: string; frame_index: string | null; frame_pos: { x: number; y: number } | null }; quality_flags: string[]; actors: ReplayActor[]; candidates: Array<{ track_id: number; rank: number; confidence: number | null }>; representative_court_positions: ReplayCourtPosition[] }
export interface ReplayPath { id: string; sequence_index: number; start_key_point_id: string; end_key_point_id: string; start_frame_index: string | null; end_frame_index: string | null; render_state: string; is_terminal_segment: boolean; quality_flags: string[]; start_court_positions: ReplayCourtPosition[]; end_court_positions: ReplayCourtPosition[] }
export interface CoachRallyReplay {
  schema_version: '1.0.0'
  rally: { id: string; match_id: string; ordinal: number; processing_status: string; set: { id: string; number: number }; outcome: { score_resolution: string; scoring_court_side: string | null; scoring_team: CoachTeam | null }; left_team: CoachTeam; right_team: CoachTeam }
  submission: { id: string; annotation_revision: string; submitted_at: string; key_points: Array<{ id: string; sequence_index: number; marker_kind: string; is_terminal: boolean; clip_pts: string | null; clip_time_us: string | null; clip_frame_index: string | null }> }
  clip: { id: string; url: string; duration_us: string; fps: { num: number; den: number } } | null
  analysis: { id: string; analysis_id: string; version: string; producer: { name: string; build_id: string }; summary: unknown; tracks: Array<{ track_id: number; court_side: string; first_frame_index: string; last_frame_index: string; mean_confidence: number | null }>; contact_events: ReplayContactEvent[]; paths: ReplayPath[] } | null
}

const COACH_MATCH_STATE = `query CoachMatchState($matchId: ID!) { coachMatchState(matchId: $matchId) }`

export function createCoachDomainClient(transport: GraphQLTransport) {
  return {
    async matchState(matchId: string) {
      const result = await transport.request<{ coachMatchState: CoachMatchState | null }>(COACH_MATCH_STATE, { matchId })
      return result.coachMatchState
    },
    async rallyReplay(rallyId: string) {
      const result = await transport.request<{ coachRallyReplay: CoachRallyReplay | null }>('query CoachRallyReplay($rallyId: ID!) { coachRallyReplay(rallyId: $rallyId) }', { rallyId })
      return result.coachRallyReplay
    },
  }
}
