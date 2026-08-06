from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, field_validator, model_validator

WireUInt64 = str


def _digits(value: str, name: str) -> str:
    if not value.isdigit():
        raise ValueError(f"{name} must be a non-negative decimal string")
    return value


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


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


class Outcome(StrictModel):
    score_resolution: Literal["resolved", "unknown"]
    scoring_court_side: Literal["left", "right"] | None

    @model_validator(mode="after")
    def state_matches_side(self) -> "Outcome":
        if self.score_resolution == "resolved" and self.scoring_court_side is None:
            raise ValueError("resolved outcome requires scoring_court_side")
        if self.score_resolution == "unknown" and self.scoring_court_side is not None:
            raise ValueError("unknown outcome requires null scoring_court_side")
        return self


class CallbackTarget(StrictModel):
    url: HttpUrl
    token: str = Field(min_length=16)
    expires_at: datetime


class AIJobRequest(StrictModel):
    schema_version: Literal["1.1.0"]
    ai_job_id: str = Field(min_length=1, max_length=128)
    rally_submission_id: str = Field(min_length=1, max_length=128)
    rally_id: str = Field(min_length=1, max_length=128)
    match_id: str = Field(min_length=1, max_length=128)
    annotation_revision: WireUInt64
    clip: ClipInput
    key_points: list[KeyPointInput] = Field(min_length=1)
    outcome: Outcome
    callback: CallbackTarget

    @field_validator("annotation_revision")
    @classmethod
    def validate_revision(cls, value: str) -> str:
        return _digits(value, "annotation_revision")

    @model_validator(mode="after")
    def validate_key_points(self) -> "AIJobRequest":
        if self.key_points[0].marker_kind != "service":
            raise ValueError("the first human marker must have marker_kind=service because Z starts the rally; this is not an AI action label")
        if sum(p.marker_kind == "service" for p in self.key_points) != 1:
            raise ValueError("exactly one service marker is required")
        if [p.sequence_index for p in self.key_points] != list(range(len(self.key_points))):
            raise ValueError("sequence_index must be contiguous from zero")
        if sum(p.is_terminal for p in self.key_points) != 1 or not self.key_points[-1].is_terminal:
            raise ValueError("last key point must be the only terminal point")
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
    sequence_index: int = Field(ge=0)
    marker_kind: Literal["service", "contact"]
    is_terminal: bool
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
    is_terminal_segment: bool
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


class AnalysisResult(StrictModel):
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
    def validate_counts_and_refs(self) -> "AnalysisResult":
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


class ProviderLimits(StrictModel):
    max_clip_bytes: WireUInt64 | None = None
    max_clip_duration_us: WireUInt64 | None = None
    max_concurrent_jobs: int | None = Field(default=None, ge=1)

    @field_validator("max_clip_bytes", "max_clip_duration_us")
    @classmethod
    def validate_limits(cls, value: str | None, info: Any) -> str | None:
        return None if value is None else _digits(value, info.field_name)


class ProviderCapabilities(StrictModel):
    schema_version: Literal["1.0.0"]
    provider_name: str = Field(min_length=1)
    provider_build_id: str = Field(min_length=1)
    supported_job_schema_versions: list[str] = Field(min_length=1)
    supported_result_schema_versions: list[str] = Field(min_length=1)
    supported_overlay_formats: list[str] = Field(min_length=1)
    optional_extensions: OptionalExtensionsCapability
    action_taxonomies: list[ActionTaxonomyCapability]
    limits: ProviderLimits | None = None


class JobAccepted(StrictModel):
    schema_version: Literal["1.0.0"]
    ai_job_id: str = Field(min_length=1, max_length=128)
    provider_job_id: str = Field(min_length=1, max_length=128)
    state: Literal["accepted"]
    accepted_at: datetime


class AnalysisBundle(StrictModel):
    result: AnalysisResult
    overlay_bytes: bytes
