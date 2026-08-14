from __future__ import annotations

from base64 import b64decode
from datetime import datetime
from math import sqrt
from struct import iter_unpack
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, field_validator, model_validator

WireUInt64 = str


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _digits(value: str, name: str) -> str:
    if not value.isdigit():
        raise ValueError(f"{name} must be a non-negative decimal string")
    return value


class MediaRational(StrictModel):
    num: int = Field(gt=0)
    den: int = Field(gt=0)


class PlaybackWindowRequest(StrictModel):
    schema_version: Literal["1.0.0"]
    capture_session_id: str = Field(min_length=1, max_length=128)
    mode: Literal["live", "archive"]
    target_capture_time_us: str | None = None
    requested_back_us: str | None = None
    requested_forward_us: str | None = None

    @field_validator("target_capture_time_us", "requested_back_us", "requested_forward_us")
    @classmethod
    def validate_uint(cls, value: str | None, info: Any) -> str | None:
        return None if value is None else _digits(value, info.field_name)

    @model_validator(mode="after")
    def archive_target(self) -> "PlaybackWindowRequest":
        if self.mode == "archive" and self.target_capture_time_us is None:
            raise ValueError("archive requests require target_capture_time_us")
        return self


class PlaybackWindowExtendRequest(StrictModel):
    schema_version: Literal["1.0.0"]
    target_capture_time_us: str
    requested_forward_us: str | None = None

    @field_validator("target_capture_time_us", "requested_forward_us")
    @classmethod
    def validate_uint(cls, value: str | None, info: Any) -> str | None:
        return None if value is None else _digits(value, info.field_name)


class PlaybackWindowDescriptor(StrictModel):
    schema_version: Literal["1.0.0"]
    playback_window_id: str = Field(min_length=1, max_length=128)
    capture_session_id: str = Field(min_length=1, max_length=128)
    mode: Literal["live", "archive"]
    mapping_version: int = Field(ge=1)
    timeline_capture_start_us: str
    timeline_capture_end_us: str
    window_capture_start_us: str
    window_capture_end_us: str
    presentation_origin_capture_us: str
    target_player_media_time_us: str
    manifest_url: str
    expires_at: datetime
    live_edge_capture_time_us: str | None = None
    has_more_before: bool
    has_more_after: bool

    @field_validator("timeline_capture_start_us", "timeline_capture_end_us", "window_capture_start_us", "window_capture_end_us", "presentation_origin_capture_us", "target_player_media_time_us", "live_edge_capture_time_us")
    @classmethod
    def validate_uint(cls, value: str | None, info: Any) -> str | None:
        return None if value is None else _digits(value, info.field_name)


class PlaybackCursor(StrictModel):
    schema_version: Literal["1.0.0"]
    playback_window_id: str = Field(min_length=1, max_length=128)
    mapping_version: int = Field(ge=1)
    player_media_time_us: str
    observation_source: Literal["request_video_frame_callback", "current_time_fallback"]
    presented_frames: str | None = None
    seek_generation: int = Field(ge=0)
    cursor_status: Literal["ready", "seeking", "stale", "gap"]

    @field_validator("player_media_time_us", "presented_frames")
    @classmethod
    def validate_uint(cls, value: str | None, info: Any) -> str | None:
        return None if value is None else _digits(value, info.field_name)


class MediaAnchorBase(StrictModel):
    playback_window_id: str = Field(min_length=1, max_length=128)
    capture_session_id: str = Field(min_length=1, max_length=128)
    capture_epoch_id: str = Field(min_length=1, max_length=128)
    dvr_segment_id: str | None = None
    source_pts: str
    source_time_base: MediaRational
    capture_time_us: str
    capture_frame_index: str
    mapping_version: int = Field(ge=1)
    timing_precision: Literal["frame_exact", "pts_exact", "estimated"]

    @field_validator("source_pts")
    @classmethod
    def validate_pts(cls, value: str) -> str:
        if not value or (value[0] == "-" and not value[1:].isdigit()) or (value[0] != "-" and not value.isdigit()):
            raise ValueError("source_pts must be a signed decimal string")
        return value

    @field_validator("capture_time_us", "capture_frame_index")
    @classmethod
    def validate_uint(cls, value: str, info: Any) -> str:
        return _digits(value, info.field_name)


class ResolvedMediaAnchor(MediaAnchorBase):
    schema_version: Literal["1.0.0"]
    resolved_player_media_time_us: str
    snap_distance_us: str | None = None

    @field_validator("resolved_player_media_time_us", "snap_distance_us")
    @classmethod
    def validate_resolved_uint(cls, value: str | None, info: Any) -> str | None:
        return None if value is None else _digits(value, info.field_name)


class FrameStepRequest(StrictModel):
    schema_version: Literal["1.1.0"]
    capture_session_id: str = Field(min_length=1, max_length=128)
    playback_window_id: str = Field(min_length=1, max_length=128)
    mapping_version: int = Field(ge=1)
    capture_frame_index: str
    direction: Literal["previous", "next"]
    count: int = Field(ge=1, le=120)

    @field_validator("capture_frame_index")
    @classmethod
    def validate_frame(cls, value: str) -> str:
        return _digits(value, "capture_frame_index")


class CanonicalFrameAnchor(MediaAnchorBase):
    schema_version: Literal["1.0.0"]
    player_media_time_us: str

    @field_validator("player_media_time_us")
    @classmethod
    def validate_player_time(cls, value: str) -> str:
        return _digits(value, "player_media_time_us")


class MediaApiError(StrictModel):
    schema_version: Literal["1.0.0"]
    code: Literal["BAD_REQUEST", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "MAPPING_STALE", "MEDIA_NOT_READY", "WINDOW_BOUNDARY", "WINDOW_EXPIRED", "CURSOR_NOT_READY", "CAPTURE_GAP", "SAMPLE_NOT_FOUND"]
    message: str = Field(min_length=1, max_length=512)
    request_id: str = Field(min_length=1, max_length=128)
    details: dict[str, Any] | None = None


class Rational(StrictModel):
    num: int = Field(gt=0)
    den: int = Field(gt=0)


class FramePos(StrictModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)


class FrameBBox(StrictModel):
    x1: float = Field(ge=0, le=1)
    y1: float = Field(ge=0, le=1)
    x2: float = Field(ge=0, le=1)
    y2: float = Field(ge=0, le=1)

    @model_validator(mode="after")
    def ordered(self) -> "FrameBBox":
        if self.x1 > self.x2 or self.y1 > self.y2:
            raise ValueError("frame_bbox coordinates must be ordered")
        return self


class CourtPos(StrictModel):
    # Court interior is 0..1; out-of-court values are intentionally valid.
    x: float
    y: float


class VideoMetadata(StrictModel):
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    fps: Rational
    time_base: Rational
    total_frames: WireUInt64
    duration_us: WireUInt64
    has_audio: bool

    @field_validator("total_frames", "duration_us")
    @classmethod
    def validate_wire_uint64(cls, value: str, info: Any) -> str:
        return _digits(value, info.field_name)


class ClipInput(StrictModel):
    clip_asset_id: str = Field(min_length=1, max_length=128)
    download_url: HttpUrl
    download_url_expires_at: datetime
    sha256: str = Field(pattern=r"^[A-Fa-f0-9]{64}$")
    byte_length: WireUInt64
    content_type: Literal["video/mp4"]
    video: VideoMetadata

    @field_validator("byte_length")
    @classmethod
    def validate_byte_length(cls, value: str) -> str:
        return _digits(value, "byte_length")


class KeyPointInput(StrictModel):
    key_point_id: str = Field(min_length=1, max_length=128)
    sequence_index: int = Field(ge=0)
    marker_kind: Literal["service", "contact"]
    is_terminal: bool
    clip_pts: WireUInt64
    clip_time_us: WireUInt64
    clip_frame_index: WireUInt64

    @field_validator("clip_pts", "clip_time_us", "clip_frame_index")
    @classmethod
    def validate_wire_uint64(cls, value: str, info: Any) -> str:
        return _digits(value, info.field_name)


class RallyBoundaryInput(StrictModel):
    kind: Literal["start", "end"]
    clip_pts: WireUInt64
    clip_time_us: WireUInt64
    clip_frame_index: WireUInt64

    @field_validator("clip_pts", "clip_time_us", "clip_frame_index")
    @classmethod
    def validate_wire_uint64(cls, value: str, info: Any) -> str:
        return _digits(value, info.field_name)


class Outcome(StrictModel):
    score_resolution: Literal["pending", "resolved", "unknown"]
    scoring_court_side: Literal["left", "right"] | None

    @model_validator(mode="after")
    def state_matches_side(self) -> "Outcome":
        if self.score_resolution == "resolved" and self.scoring_court_side is None:
            raise ValueError("resolved outcome requires scoring_court_side")
        if self.score_resolution in {"pending", "unknown"} and self.scoring_court_side is not None:
            raise ValueError("pending or unknown outcome requires null scoring_court_side")
        return self


class CallbackTarget(StrictModel):
    url: HttpUrl
    token: str = Field(min_length=16)
    expires_at: datetime


class AnalysisDataArtifact(StrictModel):
    analysis_run_id: str = Field(min_length=1, max_length=128)
    download_url: HttpUrl
    download_url_expires_at: datetime
    sha256: str = Field(pattern=r"^[A-Fa-f0-9]{64}$")
    byte_length: WireUInt64
    content_type: Literal["application/vnd.volleyball.analysis-data+flatbuffers;version=1"]

    @field_validator("byte_length")
    @classmethod
    def validate_byte_length(cls, value: str) -> str:
        return _digits(value, "byte_length")


class AnalysisModules(StrictModel):
    court: Literal["run", "reuse"]
    tracking: Literal["run", "reuse"]
    reid: Literal["run", "reuse"]
    contacts: Literal["run", "reuse"]


class AnalysisPlan(StrictModel):
    mode: Literal["full", "selective"]
    modules: AnalysisModules
    source_analysis_data: AnalysisDataArtifact | None
    preserve_manual_corrections: Literal[True]

    @model_validator(mode="after")
    def validate_source(self) -> "AnalysisPlan":
        values = self.modules.model_dump()
        if self.mode == "full":
            if self.source_analysis_data is not None or set(values.values()) != {"run"}:
                raise ValueError("full analysis must run every module without source AnalysisData")
        elif self.source_analysis_data is None:
            raise ValueError("selective analysis requires source AnalysisData")
        if values["tracking"] == "run" and (values["reid"] != "run" or values["contacts"] != "run"):
            raise ValueError("tracking rerun requires ReID and contacts to rerun")
        return self


class AIJobRequest(StrictModel):
    schema_version: Literal["3.0.0"]
    ai_job_id: str = Field(min_length=1, max_length=128)
    rally_submission_id: str = Field(min_length=1, max_length=128)
    rally_id: str = Field(min_length=1, max_length=128)
    match_id: str = Field(min_length=1, max_length=128)
    annotation_revision: WireUInt64
    clip: ClipInput
    key_points: list[KeyPointInput]
    boundaries: list[RallyBoundaryInput]
    outcome: Outcome
    callback: CallbackTarget
    analysis_plan: AnalysisPlan

    @field_validator("annotation_revision")
    @classmethod
    def validate_revision(cls, value: str) -> str:
        return _digits(value, "annotation_revision")

    @model_validator(mode="after")
    def validate_key_points(self) -> "AIJobRequest":
        if [boundary.kind for boundary in self.boundaries] != ["start", "end"]:
            raise ValueError("jobs require exactly one ordered start/end boundary pair")
        if any(point.marker_kind != "contact" or point.is_terminal for point in self.key_points):
            raise ValueError("jobs accept only non-terminal contact hints")
        boundary_frames = [int(boundary.clip_frame_index) for boundary in self.boundaries]
        boundary_times = [int(boundary.clip_time_us) for boundary in self.boundaries]
        boundary_pts = [int(boundary.clip_pts) for boundary in self.boundaries]
        if boundary_frames != sorted(boundary_frames) or boundary_times != sorted(boundary_times) or boundary_pts != sorted(boundary_pts):
            raise ValueError("rally boundaries must be monotonic in clip frame/time/PTS")
        if boundary_frames[-1] >= int(self.clip.video.total_frames) or boundary_times[-1] > int(self.clip.video.duration_us):
            raise ValueError("rally boundary outside clip")
        if [p.sequence_index for p in self.key_points] != list(range(len(self.key_points))):
            raise ValueError("sequence_index must be contiguous from zero")
        frames = [int(p.clip_frame_index) for p in self.key_points]
        times = [int(p.clip_time_us) for p in self.key_points]
        pts = [int(p.clip_pts) for p in self.key_points]
        if any(frame >= int(self.clip.video.total_frames) for frame in frames):
            raise ValueError("key point frame outside clip")
        if any(time > int(self.clip.video.duration_us) for time in times):
            raise ValueError("key point time outside clip")
        if frames != sorted(frames) or times != sorted(times) or pts != sorted(pts):
            raise ValueError("key points must be monotonic in clip frame/time/PTS")
        return self


class ActionExtension(StrictModel):
    label: str = Field(min_length=1)
    taxonomy_id: str | None = Field(default=None, min_length=1)
    taxonomy_version: str | None = Field(default=None, min_length=1)
    confidence: float | None = Field(default=None, ge=0, le=1)
    attributes: dict[str, Any] | None = None


class Track(StrictModel):
    track_id: int = Field(ge=0, le=65534)
    court_side: Literal["left", "right", "unknown"]
    first_frame_index: WireUInt64
    last_frame_index: WireUInt64
    mean_confidence: float | None = Field(default=None, ge=0, le=1)
    metadata: dict[str, Any] | None = None

    @field_validator("first_frame_index", "last_frame_index")
    @classmethod
    def validate_frame(cls, value: str, info: Any) -> str:
        return _digits(value, info.field_name)


def _reid_descriptor(value: str, dimension: int, name: str) -> str:
    try:
        raw = b64decode(value, validate=True)
    except ValueError as error:
        raise ValueError(f"{name} must be valid base64") from error
    if len(raw) != dimension * 4:
        raise ValueError(f"{name} must contain {dimension} Float32LE values")
    values = [entry[0] for entry in iter_unpack("<f", raw)]
    length = sqrt(sum(component * component for component in values))
    if not 0.999 <= length <= 1.001:
        raise ValueError(f"{name} must be L2-normalized")
    return value


class NestedReIDDescriptors(StrictModel):
    dino: str
    osnet: str
    kpr: str
    kpr_prompt: str

    @model_validator(mode="after")
    def validate_descriptors(self) -> "NestedReIDDescriptors":
        _reid_descriptor(self.dino, 384, "dino")
        _reid_descriptor(self.osnet, 512, "osnet")
        _reid_descriptor(self.kpr, 4096, "kpr")
        _reid_descriptor(self.kpr_prompt, 4096, "kpr_prompt")
        return self


class NestedReIDRecipe(StrictModel):
    name: Literal["nested-part-adaptation"]
    version: Literal["1.0.0"]
    selection_protocol: Literal["past-only-nested-leave-one-clip-out"]
    roster_contract: Literal["fixed-six-per-team"]
    modalities: list[dict[str, Any]] = Field(min_length=4)


class FixedRosterTracklet(StrictModel):
    canonical_track_id: int = Field(ge=0, le=65534)
    track_ids: list[int] = Field(min_length=1)
    court_side: Literal["left", "right", "unknown"]
    median_court_pos: tuple[float, float] | None
    first_frame_index: WireUInt64
    last_frame_index: WireUInt64
    sample_count: int = Field(ge=1)
    mean_quality: float = Field(ge=0, le=1)
    prompt_coverage: float = Field(ge=0, le=1)
    descriptors: NestedReIDDescriptors | None
    cannot_link_canonical_track_ids: list[int]

    @field_validator("first_frame_index", "last_frame_index")
    @classmethod
    def validate_frame(cls, value: str, info: Any) -> str:
        return _digits(value, info.field_name)

    @model_validator(mode="after")
    def validate_track_evidence(self) -> "FixedRosterTracklet":
        if int(self.first_frame_index) > int(self.last_frame_index):
            raise ValueError("ReID feature first frame cannot exceed last frame")
        if self.canonical_track_id not in self.track_ids or len(self.track_ids) != len(set(self.track_ids)):
            raise ValueError("ReID aliases must uniquely contain the canonical TID")
        if len(self.cannot_link_canonical_track_ids) != len(set(self.cannot_link_canonical_track_ids)):
            raise ValueError("ReID cannot-link track IDs must be unique")
        if self.canonical_track_id in self.cannot_link_canonical_track_ids:
            raise ValueError("ReID feature cannot conflict with itself")
        return self


class FixedRosterReID(StrictModel):
    schema_version: Literal["2.0.0"]
    scope: Literal["clip"]
    identity_contract: Literal["fixed-six-per-team"]
    slots_per_team: Literal[6]
    descriptor_recipe: NestedReIDRecipe
    tracklets: list[FixedRosterTracklet]

    @model_validator(mode="after")
    def validate_complete_sides(self) -> "FixedRosterReID":
        canonical = {tracklet.canonical_track_id for tracklet in self.tracklets}
        aliases = [track_id for tracklet in self.tracklets for track_id in tracklet.track_ids]
        if len(canonical) != len(self.tracklets) or len(aliases) != len(set(aliases)):
            raise ValueError("ReID canonical and alias TIDs must be unique")
        for tracklet in self.tracklets:
            for linked in tracklet.cannot_link_canonical_track_ids:
                other = next((candidate for candidate in self.tracklets if candidate.canonical_track_id == linked), None)
                if other is None or tracklet.canonical_track_id not in other.cannot_link_canonical_track_ids:
                    raise ValueError("ReID cannot-links must be symmetric canonical TIDs")
        return self


class Actor(StrictModel):
    track_id: int = Field(ge=0, le=65534)
    observation_frame_index: WireUInt64
    association_confidence: float | None = Field(default=None, ge=0, le=1)
    frame_bbox: FrameBBox | None = None
    frame_foot_pos: FramePos | None = None
    court_pos: CourtPos | None = None
    action: ActionExtension | None = None

    @field_validator("observation_frame_index")
    @classmethod
    def validate_observation_frame(cls, value: str) -> str:
        return _digits(value, "observation_frame_index")


class ActorCandidate(StrictModel):
    track_id: int = Field(ge=0, le=65534)
    rank: int = Field(ge=1)
    confidence: float | None = Field(default=None, ge=0, le=1)


class BallObservation(StrictModel):
    state: Literal["observed", "interpolated", "missing"]
    sample_frame_index: WireUInt64 | None = None
    frame_pos: FramePos | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)

    @field_validator("sample_frame_index")
    @classmethod
    def validate_sample_frame(cls, value: str | None) -> str | None:
        return None if value is None else _digits(value, "sample_frame_index")

    @model_validator(mode="after")
    def state_matches_payload(self) -> "BallObservation":
        if self.state == "missing":
            if self.frame_pos is not None or self.sample_frame_index is not None:
                raise ValueError("missing ball cannot carry sample_frame_index or frame_pos")
        elif self.frame_pos is None or self.sample_frame_index is None:
            raise ValueError("observed/interpolated ball requires sample_frame_index and frame_pos")
        return self


class RepresentativeCourtPosition(StrictModel):
    track_id: int | None = Field(default=None, ge=0, le=65534)
    basis: Literal["player_footprint_proxy", "terminal_projection", "provider_defined"]
    court_pos: CourtPos
    confidence: float | None = Field(default=None, ge=0, le=1)


class ContactEvent(StrictModel):
    key_point_id: str = Field(min_length=1, max_length=128)
    source_key_point_id: str | None = Field(min_length=1, max_length=128)
    anchor_origin: Literal["human_anchor", "ai_detected"]
    detection_confidence: float | None = Field(default=None, ge=0, le=1)
    sequence_index: int = Field(ge=0)
    marker_kind: Literal["contact"]
    is_terminal: Literal[False]
    anchor_frame_index: WireUInt64
    resolved_frame_index: WireUInt64 | None = None
    association_state: Literal["resolved_single", "resolved_multiple", "ambiguous", "unresolved", "no_player"]
    actors: list[Actor]
    actor_candidates: list[ActorCandidate]
    ball: BallObservation
    representative_court_positions: list[RepresentativeCourtPosition]
    quality_flags: list[str]
    extensions: dict[str, Any] | None = None

    @field_validator("anchor_frame_index", "resolved_frame_index")
    @classmethod
    def validate_frame(cls, value: str | None, info: Any) -> str | None:
        return None if value is None else _digits(value, info.field_name)

    @model_validator(mode="after")
    def validate_association(self) -> "ContactEvent":
        n_actors, n_candidates = len(self.actors), len(self.actor_candidates)
        expected = {
            "resolved_single": n_actors == 1 and n_candidates == 0,
            "resolved_multiple": n_actors >= 2 and n_candidates == 0,
            "ambiguous": n_actors == 0 and n_candidates >= 1,
            "unresolved": n_actors == 0 and n_candidates == 0,
            "no_player": n_actors == 0 and n_candidates == 0,
        }
        if not expected[self.association_state]:
            raise ValueError("actors/candidates do not match association_state")
        return self


class PathSegment(StrictModel):
    sequence_index: int = Field(ge=0)
    start_key_point_id: str = Field(min_length=1, max_length=128)
    end_key_point_id: str = Field(min_length=1, max_length=128)
    start_frame_index: WireUInt64 | None = None
    end_frame_index: WireUInt64 | None = None
    start_court_positions: list[RepresentativeCourtPosition]
    end_court_positions: list[RepresentativeCourtPosition]
    render_state: Literal["complete", "partial", "unavailable"]
    is_terminal_segment: Literal[False]
    quality_flags: list[str]

    @field_validator("start_frame_index", "end_frame_index")
    @classmethod
    def validate_frame(cls, value: str | None, info: Any) -> str | None:
        return None if value is None else _digits(value, info.field_name)


class Producer(StrictModel):
    name: str = Field(min_length=1)
    build_id: str = Field(min_length=1)
    sdk_version: str | None = Field(default=None, min_length=1)


class AnalysisSummary(StrictModel):
    track_count: int = Field(ge=0)
    contact_event_count: int = Field(ge=0)
    path_segment_count: int = Field(ge=0)
    unresolved_event_count: int = Field(ge=0)
    multiple_event_count: int | None = Field(default=None, ge=0)
    warnings: list[str] | None = None


class AnalysisDomainData(StrictModel):
    schema_version: Literal["1.0.0"]
    analysis_id: str = Field(min_length=1, max_length=128)
    analysis_version: str = Field(min_length=1, max_length=256)
    ai_job_id: str = Field(min_length=1, max_length=128)
    rally_submission_id: str = Field(min_length=1, max_length=128)
    rally_id: str = Field(min_length=1, max_length=128)
    match_id: str = Field(min_length=1, max_length=128)
    annotation_revision: WireUInt64
    clip_asset_id: str = Field(min_length=1, max_length=128)
    input_clip_sha256: str = Field(pattern=r"^[A-Fa-f0-9]{64}$")
    producer: Producer
    tracks: list[Track]
    contact_events: list[ContactEvent]
    path_segments: list[PathSegment]
    summary: AnalysisSummary
    extensions: dict[str, Any] = Field(default_factory=dict)

    @field_validator("annotation_revision")
    @classmethod
    def validate_revision(cls, value: str) -> str:
        return _digits(value, "annotation_revision")

    @model_validator(mode="after")
    def validate_counts_and_refs(self) -> "AnalysisDomainData":
        reid_payload = self.extensions.get("fixed_roster_reid")
        if reid_payload is not None:
            feature_bank = FixedRosterReID.model_validate(reid_payload)
            result_tracks = {track.track_id for track in self.tracks}
            feature_tracks = {
                track_id for tracklet in feature_bank.tracklets for track_id in tracklet.track_ids
            }
            if not feature_tracks.issubset(result_tracks):
                raise ValueError("ReID feature references an unknown result track")
        if len(self.tracks) != self.summary.track_count:
            raise ValueError("summary track_count mismatch")
        if len(self.contact_events) != self.summary.contact_event_count:
            raise ValueError("summary contact_event_count mismatch")
        if len(self.path_segments) != self.summary.path_segment_count:
            raise ValueError("summary path_segment_count mismatch")
        if len(self.path_segments) != max(len(self.contact_events) - 1, 0):
            raise ValueError("path segment count must be N-1")
        track_ids = {track.track_id for track in self.tracks}
        if len(track_ids) != len(self.tracks):
            raise ValueError("track_id must be unique within one analysis")
        for track in self.tracks:
            if int(track.first_frame_index) > int(track.last_frame_index):
                raise ValueError("track first_frame_index cannot exceed last_frame_index")
        if [event.sequence_index for event in self.contact_events] != list(range(len(self.contact_events))):
            raise ValueError("contact event sequence_index must be contiguous from zero")
        if [segment.sequence_index for segment in self.path_segments] != list(range(len(self.path_segments))):
            raise ValueError("path segment sequence_index must be contiguous from zero")
        for event in self.contact_events:
            if any(actor.track_id not in track_ids for actor in event.actors):
                raise ValueError("event actor references unknown track")
            if any(candidate.track_id not in track_ids for candidate in event.actor_candidates):
                raise ValueError("event candidate references unknown track")
            if any(position.track_id is not None and position.track_id not in track_ids for position in event.representative_court_positions):
                raise ValueError("representative position references unknown track")
        unresolved = sum(event.association_state in {"ambiguous", "unresolved"} for event in self.contact_events)
        multiple = sum(event.association_state == "resolved_multiple" for event in self.contact_events)
        if unresolved != self.summary.unresolved_event_count:
            raise ValueError("summary unresolved_event_count mismatch")
        if self.summary.multiple_event_count is not None and multiple != self.summary.multiple_event_count:
            raise ValueError("summary multiple_event_count mismatch")
        for index, segment in enumerate(self.path_segments):
            start = self.contact_events[index]
            end = self.contact_events[index + 1]
            if segment.start_key_point_id != start.key_point_id or segment.end_key_point_id != end.key_point_id:
                raise ValueError("path segment must reference adjacent contact events")
            if segment.start_court_positions != start.representative_court_positions or segment.end_court_positions != end.representative_court_positions:
                raise ValueError("path segment A/B positions must equal referenced contact event positions")
            if segment.is_terminal_segment != end.is_terminal:
                raise ValueError("terminal segment must end at the terminal contact event")
        return self


class ActionTaxonomyCapability(StrictModel):
    taxonomy_id: str = Field(min_length=1)
    taxonomy_version: str = Field(min_length=1)
    labels_url: HttpUrl | None = None


class OptionalExtensionsCapability(StrictModel):
    action: bool
    group_phase: bool
    confidence: bool
    fixed_roster_reid: bool = False


class ProviderLimits(StrictModel):
    max_clip_bytes: WireUInt64 | None = None
    max_clip_duration_us: WireUInt64 | None = None
    max_concurrent_jobs: int | None = Field(default=None, ge=1)

    @field_validator("max_clip_bytes", "max_clip_duration_us")
    @classmethod
    def validate_limits(cls, value: str | None, info: Any) -> str | None:
        return None if value is None else _digits(value, info.field_name)


class ProviderCapabilities(StrictModel):
    schema_version: Literal["2.0.0"]
    provider_name: str = Field(min_length=1)
    provider_build_id: str = Field(min_length=1)
    supported_job_schema_versions: list[str] = Field(min_length=1)
    supported_analysis_data_versions: list[str] = Field(min_length=1)
    supported_analysis_modules: list[Literal["court", "tracking", "reid", "contacts"]] = Field(min_length=1)
    supports_selective_rerun: bool
    optional_extensions: OptionalExtensionsCapability
    action_taxonomies: list[ActionTaxonomyCapability]
    limits: ProviderLimits | None = None


class JobAccepted(StrictModel):
    schema_version: Literal["1.0.0"]
    ai_job_id: str = Field(min_length=1, max_length=128)
    provider_job_id: str = Field(min_length=1, max_length=128)
    state: Literal["accepted"]
    accepted_at: datetime


class AnalysisDataBundle(StrictModel):
    domain: AnalysisDomainData
    analysis_data_bytes: bytes
