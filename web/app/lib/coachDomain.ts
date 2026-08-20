import type {
  AnnotationRallyProcessingUpdate,
  BallEventValue,
} from '@volleyball-monitoring/contracts'
import type { GraphQLTransport, RosterPosition } from './coreDomain'

export interface CoachTeam {
  id: string
  name: string
  shortName: string
}
export interface CoachSideAssignment {
  id: string
  left_team_id: string
  right_team_id: string
}
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
export interface CoachCapture {
  id: string
  source_kind: string
  source_label: string | null
  status: string
  health: string
}
export interface CoachDraft {
  id: string
  ordinal: number
  display_ordinal: number
  display_set_number: number
  annotation_revision: string
  annotation_status: 'open' | 'ready'
  active_submission_id: string | null
  score_resolution?: string
  scoring_court_side?: string | null
  scoring_team_id?: string | null
  side_assignment_id?: string
  side_assignment_reversed?: boolean
  left_team_id?: string
  right_team_id?: string
  set_id: string
  set_number: number
  key_points: Array<{
    id: string
    sequence_index: number
    marker_kind: string
    is_terminal: boolean
    capture_time_us: string
    capture_frame_index: string
    ball_event?: BallEventValue | null
  }>
  boundaries?: Array<{
    kind: 'start' | 'end'
    capture_time_us: string
    capture_frame_index: string
  }>
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
    supersedes_submission_id: string | null
    submitted_at: string
    score_resolution: string
    scoring_court_side: string | null
    scoring_team_id: string | null
    side_assignment_id: string
    side_assignment_reversed: boolean
    left_team_id: string
    right_team_id: string
    contact_count: number
    key_points: Array<{
      id: string
      sequence_index: number
      marker_kind: string
      is_terminal: boolean
      capture_time_us: string
      capture_frame_index: string
      ball_event?: BallEventValue | null
    }>
    boundaries?: Array<{
      kind: 'start' | 'end'
      capture_time_us: string
      capture_frame_index: string
    }>
    clip: {
      id: string
      status: string
      start_capture_time_us: string
      end_capture_time_us: string
      duration_us: string
    } | null
    processing: AnnotationRallyProcessingUpdate
    analysis: {
      id: string
      status: string
      version: string
      summary?: unknown
      identity_mapping_completed: boolean
      coverage_start_capture_time_us: string | null
      coverage_end_capture_time_us: string | null
      byte_length: string
      track_count: number
      ball_path_count: number
      contact_count: number
      contact_points?: Array<{
        id: string
        capture_time_us: string
        frame_index: string
        source: 'ai' | 'human' | 'manual'
        confidence: number | null
      }>
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

export interface ReidJobRequestState {
  request_id: string
  analysis_run_id: string
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
  error_message: string | null
}

export interface ReidJerseySuggestionItem {
  suggestion_id: string
  tracklet_id: string
  track_id: number
  gid_id: string | null
  gid_label: string | null
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
  current_roster_entry_id: string | null
  current_jersey_number: string | null
  current_player_name: string | null
  suggested_roster_entry_id: string | null
  suggested_jersey_number: string | null
  suggested_player_name: string | null
  confidence: number | null
  alternatives: unknown
  selected_frame_indices: string[]
  montage_url: string | null
  preview_url: string | null
  changed: boolean
  applied_at: string | null
}

export interface ReidJerseySuggestionRun {
  schema_version: '1.0.0'
  run_id: string
  analysis_run_id: string
  match_id: string
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
  model_namespace: string | null
  error_message: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  items: ReidJerseySuggestionItem[]
}

export interface ReplayCourtPosition {
  track_id: number | null
  basis: string
  court_pos: { x: number; y: number }
  confidence: number | null
}
export interface ReplayActor {
  track_id: number
  observation_frame_index: string
  association_confidence: number | null
  frame_bbox: { x1: number; y1: number; x2: number; y2: number } | null
  frame_foot_pos: { x: number; y: number } | null
  court_pos: { x: number; y: number } | null
  action: unknown
}
export interface ReplayContactEvent {
  key_point_id: string
  source_key_point_id?: string | null
  anchor_origin?: 'human_anchor' | 'ai_detected' | 'review_manual'
  detection_confidence?: number | null
  detection_evidence?: unknown
  sequence_index: number
  marker_kind: string
  is_terminal: boolean
  anchor_frame_index: string
  resolved_frame_index: string | null
  anchor_time_us: string
  association_state: string
  ball_event?: {
    ordinal: number
    kind: 'serve' | 'receive' | 'contact' | 'spike'
    result: 'success' | 'failure' | null
    serve_style?: 'jump' | 'standing' | null
    semantic_source: 'human' | 'system_default' | 'automatic' | 'correction_copy'
    actor: {
      roster_entry_id: string
      jersey_number: string
      name: string
      track_id: number | null
    } | null
  } | null
  ball: { state: string; frame_index: string | null; frame_pos: { x: number; y: number } | null }
  quality_flags: string[]
  actors: ReplayActor[]
  candidates: Array<{ track_id: number; rank: number; confidence: number | null }>
  representative_court_positions: ReplayCourtPosition[]
}
export interface ReplayPath {
  id: string
  sequence_index: number
  start_key_point_id: string
  end_key_point_id: string
  start_frame_index: string | null
  end_frame_index: string | null
  render_state: string
  is_terminal_segment: boolean
  quality_flags: string[]
  start_court_positions: ReplayCourtPosition[]
  end_court_positions: ReplayCourtPosition[]
}
export interface ReplayTrackIdentity {
  roster_entry_id: string
  jersey_number: string
  position?: RosterPosition
  name: string
}
export interface ReplayGlobalIdentity {
  id: string
  label: string
  source: 'ai' | 'manual' | 'propagated'
  confidence: number | null
  identity_revision: string | null
}
export interface CoachRallyReplay {
  schema_version: '1.0.0' | '1.1.0' | '1.2.0' | '1.3.0'
  rally: {
    id: string
    match_id: string
    ordinal: number
    display_ordinal: number
    display_set_number: number
    processing_status: string
    set: { id: string; number: number }
    outcome: {
      score_resolution: string
      scoring_court_side: string | null
      scoring_team: CoachTeam | null
    }
    left_team: CoachTeam
    right_team: CoachTeam
  }
  submission: {
    id: string
    annotation_revision: string
    submitted_at: string
    key_points: Array<{
      id: string
      sequence_index: number
      marker_kind: string
      is_terminal: boolean
      clip_pts: string | null
      clip_time_us: string | null
      clip_frame_index: string | null
    }>
  }
  clip: { id: string; url: string; duration_us: string; fps: { num: number; den: number } } | null
  analysis: {
    id: string
    analysis_id: string
    version: string
    review_revision?: string
    producer: { name: string; build_id: string }
    summary: unknown
    tracks: Array<{
      track_id: number
      court_side: string
      first_frame_index: string
      last_frame_index: string
      mean_confidence: number | null
      global_identity?: ReplayGlobalIdentity | null
      identity: ReplayTrackIdentity | null
    }>
    contact_events: ReplayContactEvent[]
    paths: ReplayPath[]
  } | null
}

export interface CoachMetric {
  value: number
  sample_count: number
  excluded_count: number
  unknown_count: number
  quality_breakdown: Record<string, number>
  feature_dependencies: string[]
}
export interface CoachMatchAnalytics {
  schema_version: '1.0.0' | '1.1.0'
  match: { id: string; title: string }
  feature_availability: {
    identity: boolean
    action: boolean
    ball_events?: boolean
    court_positions: boolean
  }
  metrics: Record<string, CoachMetric>
  teams: Array<CoachTeam & { wins: number; losses: number; unknown: number; sample_count: number }>
  sets: Array<{
    set_number: number
    rally_count: number
    resolved_count: number
    unknown_count: number
    team_points: Record<string, number>
  }>
  rallies: Array<{
    id: string
    set_number: number
    ordinal: number
    score_resolution: string
    scoring_team_id: string | null
    contact_count: number
    replay_url: string
  }>
  players: Array<{
    roster_entry_id: string
    team_id: string
    jersey_number: string
    position: RosterPosition
    name: string
    contact_count: number
    sample_count: number
    rally_count: number
    action_counts: Record<string, number>
    heatmap_samples: Array<{
      x: number
      y: number
      rally_id: string
      set_number: number
      action: string | null
    }>
    error_count: number | null
  }>
  tracks: Array<{
    analysis_run_id: string
    track_id: number
    rally_id: string
    set_number: number
    rally_ordinal: number
    court_side: string
    team_id?: string | null
    first_frame_index: string
    last_frame_index: string
    observed_frame_ranges?: Array<{ start: string; end: string }> | null
    roster_entry_id: string | null
    identity_mapping_completed: boolean
    gid_id?: string | null
    gid_team_id?: string | null
    gid_slot_index?: number | null
    gid_label?: string | null
    identity_source?: 'manual' | 'ai' | 'propagated' | null
    identity_confidence?: number | null
    identity_revision?: string | null
    identity_evidence_state?: 'pending' | 'ready' | 'unavailable'
    manual_required?: boolean
    identity_preview_url?: string | null
    reid_model?: { name: string; checkpoint_sha256: string; preprocess_version: string } | null
  }>
  unassigned_tracks: Array<{
    analysis_run_id: string
    track_id: number
    rally_id: string
    set_number: number
    rally_ordinal: number
  }>
  action_events?: Array<{
    id: string
    rally_id: string
    set_number: number
    rally_ordinal: number
    analysis_run_id: string | null
    track_id: number | null
    roster_entry_id: string | null
    team_id?: string | null
    anchor_time_us: string
    action_key: string
    action_label: string
    action_confidence: number | null
    result_key: string | null
    route_start: { x: number; y: number } | null
    route_end: { x: number; y: number } | null
    court_side: string | null
    outcome: 'won' | 'lost' | 'unknown'
  }>
}
export function createCoachDomainClient(transport: GraphQLTransport) {
  return {
    async matchState(matchId: string, profile?: 'full' | 'annotation') {
      const result = await transport.request<{ coachMatchState: CoachMatchState | null }>(
        `query CoachMatchState($matchId: ID!, $profile: String) {
          coachMatchState(matchId: $matchId, profile: $profile)
        }`,
        { matchId, profile: profile ?? null },
      )
      return result.coachMatchState
    },
    async deleteRally(rallyId: string) {
      const result = await transport.request<{
        deleteRally: {
          rallyId: string
          matchId: string
          abortedJobCount: number
          removedAssetCount: number
          removedBytes: string
          cleanupWarnings: string[]
        }
      }>(
        'mutation DeleteRally($rallyId: ID!) { deleteRally(rallyId: $rallyId) { rallyId matchId abortedJobCount removedAssetCount removedBytes cleanupWarnings } }',
        { rallyId },
      )
      return result.deleteRally
    },
    async deleteRallyAnalysis(rallyId: string) {
      const result = await transport.request<{
        deleteRallyAnalysis: {
          rallyId: string
          matchId: string
          abortedJobCount: number
          removedAssetCount: number
          removedBytes: string
          cleanupWarnings: string[]
        }
      }>(
        'mutation DeleteRallyAnalysis($rallyId: ID!) { deleteRallyAnalysis(rallyId: $rallyId) { rallyId matchId abortedJobCount removedAssetCount removedBytes cleanupWarnings } }',
        { rallyId },
      )
      return result.deleteRallyAnalysis
    },
    async updateRallyPlacement(input: { rallyId: string; setNumber: number; ordinal: number }) {
      const result = await transport.request<{
        updateRallyPlacement: {
          rallyId: string
          matchId: string
          displaySetNumber: number
          displayOrdinal: number
        }
      }>(
        'mutation UpdateRallyPlacement($input: UpdateRallyPlacementInput!) { updateRallyPlacement(input: $input) { rallyId matchId displaySetNumber displayOrdinal } }',
        { input },
      )
      return result.updateRallyPlacement
    },
    async rallyReplay(rallyId: string) {
      const result = await transport.request<{ coachRallyReplay: CoachRallyReplay | null }>(
        'query CoachRallyReplay($rallyId: ID!) { coachRallyReplay(rallyId: $rallyId) }',
        { rallyId },
      )
      return result.coachRallyReplay
    },
    async analytics(matchId: string) {
      const result = await transport.request<{ coachMatchAnalytics: CoachMatchAnalytics | null }>(
        'query CoachMatchAnalytics($matchId: ID!) { coachMatchAnalytics(matchId: $matchId) }',
        { matchId },
      )
      return result.coachMatchAnalytics
    },
    async assignTrackIdentity(input: {
      analysisRunId: string
      trackId: number
      rosterEntryId: string
      identityMode?: 'from_here' | 'clip_only' | 'split_identity'
    }) {
      return transport.request<{
        assignTrackIdentity: {
          schema_version: '2.0.0'
          evidence_state: 'pending' | 'ready'
          identity_revision: string | null
          gid_id: string | null
        }
      }>(
        'mutation AssignTrackIdentity($analysisRunId: ID!, $trackId: Int!, $rosterEntryId: ID!, $identityMode: String) { assignTrackIdentity(analysisRunId: $analysisRunId, trackId: $trackId, rosterEntryId: $rosterEntryId, identityMode: $identityMode) }',
        input,
      )
    },
    async clearTrackIdentity(input: { analysisRunId: string; trackId: number }) {
      return transport.request<{ clearTrackIdentity: { schema_version: '1.0.0' } }>(
        'mutation ClearTrackIdentity($analysisRunId: ID!, $trackId: Int!) { clearTrackIdentity(analysisRunId: $analysisRunId, trackId: $trackId) }',
        input,
      )
    },
    async applyReidAutomaticAssignments(input: { analysisRunId: string }) {
      return transport.request<{
        applyReidAutomaticAssignments: {
          schema_version: '1.0.0'
          match_id: string
          analysis_run_id: string
          assigned_count: number
          already_assigned_count: number
          preserved_manual_count: number
          unresolved_count: number
        }
      }>(
        'mutation ApplyReidAutomaticAssignments($analysisRunId: ID!) { applyReidAutomaticAssignments(analysisRunId: $analysisRunId) }',
        input,
      )
    },
    async requestReidFeatureRebuild(input: {
      requestId: string
      analysisRunId: string
      reason?: string
    }) {
      const result = await transport.request<{ requestReidFeatureRebuild: ReidJobRequestState }>(
        'mutation RequestReidFeatureRebuild($requestId: ID!, $analysisRunId: ID!, $reason: String) { requestReidFeatureRebuild(requestId: $requestId, analysisRunId: $analysisRunId, reason: $reason) }',
        input,
      )
      return result.requestReidFeatureRebuild
    },
    async reidFeatureRebuildRequest(requestId: string) {
      const result = await transport.request<{
        reidFeatureRebuildRequest: ReidJobRequestState | null
      }>(
        'query ReidFeatureRebuildRequest($requestId: ID!) { reidFeatureRebuildRequest(requestId: $requestId) }',
        { requestId },
      )
      return result.reidFeatureRebuildRequest
    },
    async requestReidAssociationRerun(input: {
      requestId: string
      analysisRunId: string
      reason?: string
    }) {
      const result = await transport.request<{ requestReidAssociationRerun: ReidJobRequestState }>(
        'mutation RequestReidAssociationRerun($requestId: ID!, $analysisRunId: ID!, $reason: String) { requestReidAssociationRerun(requestId: $requestId, analysisRunId: $analysisRunId, reason: $reason) }',
        input,
      )
      return result.requestReidAssociationRerun
    },
    async reidAssociationRerunRequest(requestId: string) {
      const result = await transport.request<{
        reidAssociationRerunRequest: ReidJobRequestState | null
      }>(
        'query ReidAssociationRerunRequest($requestId: ID!) { reidAssociationRerunRequest(requestId: $requestId) }',
        { requestId },
      )
      return result.reidAssociationRerunRequest
    },
    async swapTrackGidRosterBindings(input: {
      analysisRunId: string
      trackId: number
      targetPersonClusterId: string
      reason?: string
    }) {
      return transport.request<{
        swapTrackGidRosterBindings: {
          schema_version: '1.0.0'
          match_id: string
          correction_id: string
          identity_revision: string
        }
      }>(
        'mutation SwapTrackGidRosterBindings($analysisRunId: ID!, $trackId: Int!, $targetPersonClusterId: ID!, $reason: String) { swapTrackGidRosterBindings(analysisRunId: $analysisRunId, trackId: $trackId, targetPersonClusterId: $targetPersonClusterId, reason: $reason) }',
        input,
      )
    },
    async requestReidJerseySuggestions(input: { runId: string; analysisRunId: string }) {
      const result = await transport.request<{
        requestReidJerseySuggestions: { run_id: string; match_id: string }
      }>(
        'mutation RequestReidJerseySuggestions($runId: ID!, $analysisRunId: ID!) { requestReidJerseySuggestions(runId: $runId, analysisRunId: $analysisRunId) }',
        input,
      )
      return result.requestReidJerseySuggestions
    },
    async reidJerseySuggestionRun(runId: string) {
      const result = await transport.request<{
        reidJerseySuggestionRun: ReidJerseySuggestionRun | null
      }>('query ReidJerseySuggestionRun($runId: ID!) { reidJerseySuggestionRun(runId: $runId) }', {
        runId,
      })
      return result.reidJerseySuggestionRun
    },
    async applyReidJerseySuggestion(suggestionId: string) {
      const result = await transport.request<{
        applyReidJerseySuggestion: {
          suggestion_id: string
          match_id: string
          applied: boolean
        }
      }>(
        'mutation ApplyReidJerseySuggestion($suggestionId: ID!) { applyReidJerseySuggestion(suggestionId: $suggestionId) }',
        { suggestionId },
      )
      return result.applyReidJerseySuggestion
    },
  }
}
