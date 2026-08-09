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
  winning_team_id: string | null
  side_assignment: CoachSideAssignment | null
}
export interface CoachCapture { id: string; source_kind: string; source_label: string | null; status: string; health: string }
export interface CoachDraft {
  id: string
  ordinal: number
  display_ordinal: number
  display_set_number: number
  annotation_revision: string
  annotation_status: 'open' | 'ready'
  active_submission_id: string | null
  set_id: string
  set_number: number
  key_points: Array<{ id: string; sequence_index: number; marker_kind: string; is_terminal: boolean; capture_time_us: string; capture_frame_index: string }>
}
export interface CoachRally {
  id: string
  ordinal: number
  display_ordinal: number
  display_set_number: number
  annotation_revision: string
  processing_status: string
  scoring_court_side: string | null
  scoring_team_id: string | null
  set_id: string
  set_number: number
  left_score_after: number
  right_score_after: number
  winner_side: 'left' | 'right' | null
  submission: {
    id: string
    submitted_at: string
    score_resolution: string
    scoring_court_side: string | null
    scoring_team_id: string | null
    contact_count: number
    key_points: Array<{
      id: string
      sequence_index: number
      marker_kind: string
      is_terminal: boolean
      capture_time_us: string
      capture_frame_index: string
    }>
    clip: { id: string; status: string; start_capture_time_us: string; end_capture_time_us: string; duration_us: string } | null
    analysis: {
      id: string
      status: string
      version: string
      summary: unknown
      identity_mapping_completed: boolean
      coverage_start_capture_time_us: string | null
      coverage_end_capture_time_us: string | null
      byte_length: string
      track_count: number
      ball_path_count: number
      contact_count: number
      capabilities: string[]
    } | null
  }
}
export interface CoachMatchState {
  schema_version: '1.0.0'
  match: {
    id: string
    title: string
    status: string
    clip_pre_roll_us: string
    clip_post_roll_us: string
    teams: CoachTeam[]
    sets: CoachSet[]
    captures: CoachCapture[]
    drafts: CoachDraft[]
    rallies: CoachRally[]
  }
}

export interface ReplayCourtPosition { track_id: number | null; basis: string; court_pos: { x: number; y: number }; confidence: number | null }
export interface ReplayActor { track_id: number; observation_frame_index: string; association_confidence: number | null; frame_bbox: { x1: number; y1: number; x2: number; y2: number } | null; frame_foot_pos: { x: number; y: number } | null; court_pos: { x: number; y: number } | null; action: unknown }
export interface ReplayContactEvent { key_point_id: string; sequence_index: number; marker_kind: string; is_terminal: boolean; anchor_frame_index: string; resolved_frame_index: string | null; anchor_time_us: string; association_state: string; ball: { state: string; frame_index: string | null; frame_pos: { x: number; y: number } | null }; quality_flags: string[]; actors: ReplayActor[]; candidates: Array<{ track_id: number; rank: number; confidence: number | null }>; representative_court_positions: ReplayCourtPosition[] }
export interface ReplayPath { id: string; sequence_index: number; start_key_point_id: string; end_key_point_id: string; start_frame_index: string | null; end_frame_index: string | null; render_state: string; is_terminal_segment: boolean; quality_flags: string[]; start_court_positions: ReplayCourtPosition[]; end_court_positions: ReplayCourtPosition[] }
export interface ReplayTrackIdentity { roster_entry_id: string; jersey_number: string; name: string }
export interface CoachRallyReplay {
  schema_version: '1.0.0'
  rally: { id: string; match_id: string; ordinal: number; processing_status: string; set: { id: string; number: number }; outcome: { score_resolution: string; scoring_court_side: string | null; scoring_team: CoachTeam | null }; left_team: CoachTeam; right_team: CoachTeam }
  submission: { id: string; annotation_revision: string; submitted_at: string; key_points: Array<{ id: string; sequence_index: number; marker_kind: string; is_terminal: boolean; clip_pts: string | null; clip_time_us: string | null; clip_frame_index: string | null }> }
  clip: { id: string; url: string; duration_us: string; fps: { num: number; den: number } } | null
  analysis: { id: string; analysis_id: string; version: string; producer: { name: string; build_id: string }; summary: unknown; tracks: Array<{ track_id: number; court_side: string; first_frame_index: string; last_frame_index: string; mean_confidence: number | null; identity: ReplayTrackIdentity | null }>; contact_events: ReplayContactEvent[]; paths: ReplayPath[] } | null
}

export interface CoachMetric { value: number; sample_count: number; excluded_count: number; unknown_count: number; quality_breakdown: Record<string, number>; feature_dependencies: string[] }
export interface CoachMatchAnalytics {
  schema_version: '1.0.0'
  match: { id: string; title: string }
  feature_availability: { identity: boolean; action: boolean; court_positions: boolean }
  metrics: Record<string, CoachMetric>
  teams: Array<CoachTeam & { wins: number; losses: number; unknown: number; sample_count: number }>
  players: Array<{ roster_entry_id: string; team_id: string; jersey_number: string; name: string; contact_count: number; sample_count: number }>
  tracks: Array<{ analysis_run_id: string; track_id: number; rally_id: string; set_number: number; rally_ordinal: number; court_side: string; first_frame_index: string; last_frame_index: string; roster_entry_id: string | null; identity_mapping_completed: boolean }>
  unassigned_tracks: Array<{ analysis_run_id: string; track_id: number; rally_id: string; set_number: number; rally_ordinal: number }>
}
const COACH_MATCH_STATE = `query CoachMatchState($matchId: ID!) { coachMatchState(matchId: $matchId) }`

export function createCoachDomainClient(transport: GraphQLTransport) {
  return {
    async matchState(matchId: string) {
      const result = await transport.request<{ coachMatchState: CoachMatchState | null }>(COACH_MATCH_STATE, { matchId })
      return result.coachMatchState
    },
    async deleteRally(rallyId: string) {
      const result = await transport.request<{ deleteRally: { rallyId: string; matchId: string; abortedJobCount: number; removedAssetCount: number; removedBytes: string; cleanupWarnings: string[] } }>(
        'mutation DeleteRally($rallyId: ID!) { deleteRally(rallyId: $rallyId) { rallyId matchId abortedJobCount removedAssetCount removedBytes cleanupWarnings } }',
        { rallyId },
      )
      return result.deleteRally
    },
    async updateRallyPlacement(input: { rallyId: string; setNumber: number; ordinal: number }) {
      const result = await transport.request<{ updateRallyPlacement: { rallyId: string; matchId: string; displaySetNumber: number; displayOrdinal: number } }>(
        'mutation UpdateRallyPlacement($input: UpdateRallyPlacementInput!) { updateRallyPlacement(input: $input) { rallyId matchId displaySetNumber displayOrdinal } }',
        { input },
      )
      return result.updateRallyPlacement
    },
    async rallyReplay(rallyId: string) {
      const result = await transport.request<{ coachRallyReplay: CoachRallyReplay | null }>('query CoachRallyReplay($rallyId: ID!) { coachRallyReplay(rallyId: $rallyId) }', { rallyId })
      return result.coachRallyReplay
    },
    async analytics(matchId: string) {
      const result = await transport.request<{ coachMatchAnalytics: CoachMatchAnalytics | null }>('query CoachMatchAnalytics($matchId: ID!) { coachMatchAnalytics(matchId: $matchId) }', { matchId })
      return result.coachMatchAnalytics
    },
    async assignTrackIdentity(input: { analysisRunId: string; trackId: number; rosterEntryId: string }) {
      return transport.request<{ assignTrackIdentity: { schema_version: '1.0.0' } }>('mutation AssignTrackIdentity($analysisRunId: ID!, $trackId: Int!, $rosterEntryId: ID!) { assignTrackIdentity(analysisRunId: $analysisRunId, trackId: $trackId, rosterEntryId: $rosterEntryId) }', input)
    },
    async clearTrackIdentity(input: { analysisRunId: string; trackId: number }) {
      return transport.request<{ clearTrackIdentity: { schema_version: '1.0.0' } }>('mutation ClearTrackIdentity($analysisRunId: ID!, $trackId: Int!) { clearTrackIdentity(analysisRunId: $analysisRunId, trackId: $trackId) }', input)
    },
    async setTrackIdentityMappingComplete(input: { analysisRunId: string; completed: boolean }) {
      return transport.request<{ setTrackIdentityMappingComplete: { schema_version: '1.0.0'; completed: boolean } }>('mutation SetTrackIdentityMappingComplete($analysisRunId: ID!, $completed: Boolean!) { setTrackIdentityMappingComplete(analysisRunId: $analysisRunId, completed: $completed) }', input)
    },
  }
}
