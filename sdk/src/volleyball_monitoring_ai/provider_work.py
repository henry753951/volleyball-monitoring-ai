from __future__ import annotations

from datetime import datetime
from hashlib import sha256
from itertools import pairwise
from typing import Annotated, Any, Literal, TypeAlias

from pydantic import Field, HttpUrl, TypeAdapter, field_validator, model_validator

from .models import (
    KeyPointInput,
    Outcome,
    RallyBoundaryInput,
    StrictModel,
    VideoMetadata,
    _digits,
)

ProviderWorkKind: TypeAlias = Literal[
    "ANALYSIS",
    "REID_FEATURE_EXTRACTION",
    "REID_ASSOCIATION",
    "PERSON_POSE_EVIDENCE_REBUILD",
    "IDENTITY_PREVIEW_GENERATION",
]
DescriptorModality: TypeAlias = Literal["DINO", "OSNET", "KPR", "KPR_PROMPT"]


class ProviderAnalysisClip(StrictModel):
    clip_asset_id: str = Field(min_length=1, max_length=128)
    video: VideoMetadata


class ProviderAnalysisModules(StrictModel):
    court: Literal["run"]
    tracking: Literal["run"]
    contacts: Literal["run"]
    person_pose: Literal["run"]


class ProviderAnalysisJobRequest(StrictModel):
    """Base analysis only; ReID is intentionally absent and scheduled separately."""

    schema_version: Literal["1.0.0"]
    provider_job_id: str = Field(min_length=1, max_length=128)
    ai_job_id: str = Field(min_length=1, max_length=128)
    rally_submission_id: str = Field(min_length=1, max_length=128)
    rally_id: str = Field(min_length=1, max_length=128)
    match_id: str = Field(min_length=1, max_length=128)
    annotation_revision: str
    clip: ProviderAnalysisClip
    key_points: list[KeyPointInput]
    boundaries: list[RallyBoundaryInput] = Field(min_length=2, max_length=2)
    outcome: Outcome
    modules: ProviderAnalysisModules

    @field_validator("annotation_revision")
    @classmethod
    def validate_revision(cls, value: str) -> str:
        return _digits(value, "annotation_revision")

    @field_validator("key_points")
    @classmethod
    def contact_only_key_points(cls, value: list[KeyPointInput]) -> list[KeyPointInput]:
        if any(point.marker_kind != "contact" or point.is_terminal for point in value):
            raise ValueError("provider analysis key points must be non-terminal contacts")
        if [point.sequence_index for point in value] != list(range(len(value))):
            raise ValueError("provider analysis key point sequence must be contiguous")
        frames = [int(point.clip_frame_index) for point in value]
        if frames != sorted(frames):
            raise ValueError("provider analysis key point frames must be monotonic")
        return value

    @model_validator(mode="after")
    def canonical_boundaries(self) -> ProviderAnalysisJobRequest:
        if [boundary.kind for boundary in self.boundaries] != ["start", "end"]:
            raise ValueError("provider analysis requires ordered start/end boundaries")
        if int(self.boundaries[1].clip_frame_index) < int(self.boundaries[0].clip_frame_index):
            raise ValueError("provider analysis boundaries are reversed")
        return self


class ProviderWorkHardware(StrictModel):
    accelerator: Literal["CPU", "CUDA", "MPS", "ANY"]
    minimum_memory_bytes: str | None = None

    @field_validator("minimum_memory_bytes")
    @classmethod
    def validate_memory(cls, value: str | None) -> str | None:
        return None if value is None else _digits(value, "minimum_memory_bytes")


class ProviderWorkCapability(StrictModel):
    work_kind: ProviderWorkKind
    request_schema_versions: list[str] = Field(min_length=1)
    result_schema_versions: list[str] = Field(min_length=1)
    accepted_input_artifact_kinds: list[str]
    produced_artifact_kinds: list[str]
    model_recipe_namespaces: list[str]
    hardware: ProviderWorkHardware
    max_concurrency: int = Field(ge=1, le=64)

    @model_validator(mode="after")
    def unique_values(self) -> ProviderWorkCapability:
        for name in (
            "request_schema_versions",
            "result_schema_versions",
            "accepted_input_artifact_kinds",
            "produced_artifact_kinds",
            "model_recipe_namespaces",
        ):
            values = getattr(self, name)
            if len(values) != len(set(values)):
                raise ValueError(f"{name} must contain unique values")
        return self


class ProviderWorkCapabilities(StrictModel):
    schema_version: Literal["3.0.0"]
    provider_name: str = Field(min_length=1, max_length=128)
    provider_build_id: str = Field(min_length=1, max_length=128)
    work_capabilities: list[ProviderWorkCapability] = Field(min_length=1)

    @model_validator(mode="after")
    def unique_work_kinds(self) -> ProviderWorkCapabilities:
        kinds = [capability.work_kind for capability in self.work_capabilities]
        if len(kinds) != len(set(kinds)):
            raise ValueError("work_capabilities must contain at most one entry per work kind")
        return self


class ProviderInputArtifact(StrictModel):
    artifact_id: str = Field(min_length=1, max_length=128)
    kind: str = Field(min_length=1, max_length=128)
    schema_version: str = Field(min_length=1, max_length=32)
    download_url: HttpUrl
    download_url_expires_at: datetime
    sha256: str = Field(pattern=r"^[A-Fa-f0-9]{64}$")
    byte_length: str
    content_type: str = Field(min_length=1, max_length=128)

    @field_validator("byte_length")
    @classmethod
    def validate_byte_length(cls, value: str) -> str:
        return _digits(value, "byte_length")


class ProviderWorkCallback(StrictModel):
    url: HttpUrl
    token: str = Field(min_length=16)
    expires_at: datetime
    accepted_result_kinds: list[str] = Field(min_length=1)

    @model_validator(mode="after")
    def unique_result_kinds(self) -> ProviderWorkCallback:
        if len(self.accepted_result_kinds) != len(set(self.accepted_result_kinds)):
            raise ValueError("accepted_result_kinds must be unique")
        return self


class ProviderWorkEnvelope(StrictModel):
    schema_version: Literal["1.0.0"]
    provider_job_id: str = Field(min_length=1, max_length=128)
    work_kind: ProviderWorkKind
    request_schema_version: str = Field(min_length=1, max_length=32)
    request_sha256: str = Field(pattern=r"^[A-Fa-f0-9]{64}$")
    idempotency_key: str = Field(min_length=1, max_length=128)
    input_artifacts: list[ProviderInputArtifact]
    request: dict[str, Any]
    callback: ProviderWorkCallback

    @model_validator(mode="after")
    def request_passthrough(self) -> ProviderWorkEnvelope:
        if self.request.get("schema_version") != self.request_schema_version:
            raise ValueError("request schema version does not match envelope")
        if self.request.get("provider_job_id") != self.provider_job_id:
            raise ValueError("provider_job_id passthrough mismatch")
        artifact_ids = [artifact.artifact_id for artifact in self.input_artifacts]
        if len(artifact_ids) != len(set(artifact_ids)):
            raise ValueError("input artifact IDs must be unique")
        return self


class ProviderActiveWork(StrictModel):
    provider_job_id: str = Field(min_length=1, max_length=128)
    work_kind: ProviderWorkKind
    delivery_id: str = Field(min_length=1, max_length=128)
    progress: float | None = Field(default=None, ge=0, le=1)


class ProviderWorkHello(StrictModel):
    schema_version: Literal["2.0.0"]
    type: Literal["provider_hello"]
    instance_id: str = Field(min_length=1, max_length=128)
    sdk_version: str = Field(min_length=1, max_length=128)
    provider_build_id: str = Field(min_length=1, max_length=128)
    capabilities: ProviderWorkCapabilities
    active_work: list[ProviderActiveWork]


class ProviderWorkActiveEnvelope(StrictModel):
    schema_version: Literal["2.0.0"]
    type: Literal["heartbeat", "resume_request"]
    instance_id: str = Field(min_length=1, max_length=128)
    active_work: list[ProviderActiveWork]


class ProviderWorkIdentity(StrictModel):
    schema_version: Literal["2.0.0"]
    provider_job_id: str = Field(min_length=1, max_length=128)
    work_kind: ProviderWorkKind
    delivery_id: str = Field(min_length=1, max_length=128)


class ProviderWorkAccepted(ProviderWorkIdentity):
    type: Literal["job_accepted"]
    accepted_at: datetime


class ProviderWorkFailure(ProviderWorkIdentity):
    type: Literal["job_rejected", "job_failed"]
    code: str = Field(min_length=1, max_length=128)
    message: str = Field(min_length=1, max_length=1000)
    retryable: bool


class ProviderWorkProgress(ProviderWorkIdentity):
    type: Literal["progress"]
    progress: float = Field(ge=0, le=1)
    stage: str | None = None


class ProviderWorkAbortAck(ProviderWorkIdentity):
    type: Literal["abort_ack"]
    acknowledged_at: datetime


class ProviderWorkConnectionReady(StrictModel):
    schema_version: Literal["2.0.0"]
    type: Literal["connection_ready"]
    connection_id: str = Field(min_length=1, max_length=128)
    server_time: datetime
    heartbeat_interval_seconds: int = Field(ge=1)
    lease_seconds: int = Field(ge=5)


class ProviderWorkOffer(ProviderWorkIdentity):
    type: Literal["job_offer"]
    lease_expires_at: datetime
    work: ProviderWorkEnvelope

    @model_validator(mode="after")
    def work_passthrough(self) -> ProviderWorkOffer:
        if self.work.provider_job_id != self.provider_job_id:
            raise ValueError("offered provider_job_id does not match work envelope")
        if self.work.work_kind != self.work_kind:
            raise ValueError("offered work_kind does not match work envelope")
        return self


class ProviderWorkLease(ProviderWorkIdentity):
    type: Literal["lease_renewed", "resume_job"]
    lease_expires_at: datetime


class ProviderWorkControl(ProviderWorkIdentity):
    type: Literal["abort_job", "discard_job"]
    reason: str = Field(min_length=1, max_length=1000)


class ProviderWorkCommitted(ProviderWorkIdentity):
    type: Literal["job_committed"]
    committed_at: datetime


class ProviderWorkProtocolError(StrictModel):
    schema_version: Literal["2.0.0"]
    type: Literal["protocol_error"]
    code: str = Field(min_length=1, max_length=128)
    message: str = Field(min_length=1, max_length=1000)
    retryable: bool


ProviderWorkClientMessage = Annotated[
    ProviderWorkHello
    | ProviderWorkActiveEnvelope
    | ProviderWorkAccepted
    | ProviderWorkFailure
    | ProviderWorkProgress
    | ProviderWorkAbortAck,
    Field(discriminator="type"),
]
ProviderWorkServerMessage = Annotated[
    ProviderWorkConnectionReady
    | ProviderWorkOffer
    | ProviderWorkLease
    | ProviderWorkControl
    | ProviderWorkCommitted
    | ProviderWorkProtocolError,
    Field(discriminator="type"),
]

_client_adapter = TypeAdapter(ProviderWorkClientMessage)
_server_adapter = TypeAdapter(ProviderWorkServerMessage)


def parse_provider_work_client_message(value: Any) -> ProviderWorkClientMessage:
    return _client_adapter.validate_python(value)


def parse_provider_work_server_message(value: Any) -> ProviderWorkServerMessage:
    return _server_adapter.validate_python(value)


class PoseRecipe(StrictModel):
    namespace: str = Field(min_length=1, max_length=128)
    model_name: str = Field(min_length=1, max_length=128)
    checkpoint_sha256: str = Field(pattern=r"^[A-Fa-f0-9]{64}$")
    preprocess_version: str = Field(min_length=1, max_length=128)
    keypoint_layout: Literal["COCO_17"]
    coordinate_space: Literal["NORMALIZED_VIDEO"]


class ImmutableArtifactReference(StrictModel):
    artifact_id: str = Field(min_length=1, max_length=128)
    kind: str = Field(min_length=1, max_length=128)
    schema_version: str = Field(min_length=1, max_length=32)
    sha256: str = Field(pattern=r"^[A-Fa-f0-9]{64}$")
    byte_length: str
    content_type: str = Field(min_length=1, max_length=128)

    @field_validator("byte_length")
    @classmethod
    def validate_byte_length(cls, value: str) -> str:
        return _digits(value, "byte_length")


class PersonPoseEvidenceChunk(StrictModel):
    index: int = Field(ge=0)
    start_frame_index: str
    end_frame_index: str
    player_observation_count: str
    pose_observation_count: str
    missing_observation_count: str
    artifact: ImmutableArtifactReference

    @field_validator(
        "start_frame_index",
        "end_frame_index",
        "player_observation_count",
        "pose_observation_count",
        "missing_observation_count",
    )
    @classmethod
    def validate_uint(cls, value: str, info: Any) -> str:
        return _digits(value, info.field_name)

    @model_validator(mode="after")
    def complete_accounting(self) -> PersonPoseEvidenceChunk:
        if int(self.pose_observation_count) + int(self.missing_observation_count) != int(
            self.player_observation_count
        ):
            raise ValueError("pose and missing counts must account for every player observation")
        if int(self.end_frame_index) < int(self.start_frame_index):
            raise ValueError("pose chunk frame range is reversed")
        return self


class PersonPoseEvidenceManifest(StrictModel):
    schema_version: Literal["1.0.0"]
    analysis_run_id: str = Field(min_length=1, max_length=128)
    clip_asset_id: str = Field(min_length=1, max_length=128)
    canonical_frame_count: str
    player_observation_count: str
    pose_observation_count: str
    missing_observation_count: str
    pose_recipe: PoseRecipe
    chunks: list[PersonPoseEvidenceChunk] = Field(min_length=1)
    content_sha256: str = Field(pattern=r"^[A-Fa-f0-9]{64}$")

    @field_validator(
        "canonical_frame_count",
        "player_observation_count",
        "pose_observation_count",
        "missing_observation_count",
    )
    @classmethod
    def validate_uint(cls, value: str, info: Any) -> str:
        return _digits(value, info.field_name)

    @model_validator(mode="after")
    def full_frame_coverage(self) -> PersonPoseEvidenceManifest:
        ordered = sorted(self.chunks, key=lambda chunk: chunk.index)
        if [chunk.index for chunk in ordered] != list(range(len(ordered))):
            raise ValueError("pose chunk indices must be contiguous")
        if int(ordered[0].start_frame_index) != 0:
            raise ValueError("pose chunks must begin at canonical frame zero")
        for left, right in pairwise(ordered):
            if int(right.start_frame_index) != int(left.end_frame_index) + 1:
                raise ValueError("pose chunk frame ranges must be contiguous")
        if int(ordered[-1].end_frame_index) + 1 != int(self.canonical_frame_count):
            raise ValueError("pose chunks must cover every canonical frame")
        totals = (
            sum(int(chunk.player_observation_count) for chunk in ordered),
            sum(int(chunk.pose_observation_count) for chunk in ordered),
            sum(int(chunk.missing_observation_count) for chunk in ordered),
        )
        if totals != (
            int(self.player_observation_count),
            int(self.pose_observation_count),
            int(self.missing_observation_count),
        ):
            raise ValueError("pose chunk counts do not match manifest totals")
        return self


class PlayerCropRecipe(StrictModel):
    namespace: str = Field(min_length=1, max_length=128)
    bbox_source: Literal["PERSON_POSE_EVIDENCE"]
    decode_alignment: Literal["CANONICAL_FRAME_INDEX"]
    padding_ratio: float = Field(ge=0, le=1)
    clamp_to_frame: Literal[True]


class PlayerCropSourceManifest(StrictModel):
    schema_version: Literal["1.0.0"]
    analysis_run_id: str = Field(min_length=1, max_length=128)
    clip_asset_id: str = Field(min_length=1, max_length=128)
    canonical_frame_count: str
    coordinate_space: Literal["NORMALIZED_VIDEO"]
    clip_artifact: ImmutableArtifactReference
    pose_manifest_artifact: ImmutableArtifactReference
    crop_recipe: PlayerCropRecipe
    content_sha256: str = Field(pattern=r"^[A-Fa-f0-9]{64}$")

    @field_validator("canonical_frame_count")
    @classmethod
    def validate_frame_count(cls, value: str) -> str:
        return _digits(value, "canonical_frame_count")

    @model_validator(mode="after")
    def artifact_kinds(self) -> PlayerCropSourceManifest:
        if self.clip_artifact.kind != "CANONICAL_CLIP":
            raise ValueError("crop source clip artifact must be CANONICAL_CLIP")
        if self.pose_manifest_artifact.kind != "PERSON_POSE_EVIDENCE_MANIFEST":
            raise ValueError("crop source pose artifact must be PERSON_POSE_EVIDENCE_MANIFEST")
        return self


class ReidFeatureRecipe(StrictModel):
    modality: Literal["DINO", "OSNET", "KPR", "KPR_PROMPT", "JERSEY_VLM"]
    model_namespace: str = Field(min_length=1, max_length=128)


class ReidRosterPosition(StrictModel):
    set_number: int = Field(ge=1)
    rally_ordinal: int = Field(ge=0)


class ReidRosterEntrySnapshot(StrictModel):
    roster_entry_id: str = Field(min_length=1, max_length=128)
    player_id: str | None = Field(default=None, min_length=1, max_length=128)
    jersey_number: str = Field(min_length=1, max_length=32)
    display_name: str | None = Field(default=None, min_length=1, max_length=256)
    position: Literal["UNSPECIFIED", "OH", "MB", "OPP", "S", "L", "DS"]
    active: bool


class ReidRosterTeamSnapshot(StrictModel):
    team_id: str = Field(min_length=1, max_length=128)
    court_side: Literal["LEFT", "RIGHT"]
    entries: list[ReidRosterEntrySnapshot]

    @model_validator(mode="after")
    def unique_entries(self) -> ReidRosterTeamSnapshot:
        entry_ids = [entry.roster_entry_id for entry in self.entries]
        if len(entry_ids) != len(set(entry_ids)):
            raise ValueError("roster entry ids must be unique within a team")
        return self


class ReidRosterSnapshot(StrictModel):
    schema_version: Literal["1.0.0"]
    roster_snapshot_id: str = Field(min_length=1, max_length=128)
    match_id: str = Field(min_length=1, max_length=128)
    rally_submission_id: str = Field(min_length=1, max_length=128)
    as_of_position: ReidRosterPosition
    teams: list[ReidRosterTeamSnapshot] = Field(min_length=2, max_length=2)
    content_sha256: str = Field(pattern=r"^[A-Fa-f0-9]{64}$")

    @model_validator(mode="after")
    def two_distinct_sides_and_teams(self) -> ReidRosterSnapshot:
        if {team.court_side for team in self.teams} != {"LEFT", "RIGHT"}:
            raise ValueError("roster snapshot must contain exactly one team per court side")
        if len({team.team_id for team in self.teams}) != 2:
            raise ValueError("roster snapshot teams must be distinct")
        entry_ids = [entry.roster_entry_id for team in self.teams for entry in team.entries]
        if len(entry_ids) != len(set(entry_ids)):
            raise ValueError("roster entry ids must be unique across the snapshot")
        return self


class ReidFeatureJobRequest(StrictModel):
    schema_version: Literal["1.0.0"]
    provider_job_id: str = Field(min_length=1, max_length=128)
    evidence_set_id: str = Field(min_length=1, max_length=128)
    analysis_run_id: str = Field(min_length=1, max_length=128)
    match_id: str = Field(min_length=1, max_length=128)
    analysis_evidence_artifact_id: str = Field(min_length=1, max_length=128)
    roster_snapshot_artifact_id: str = Field(min_length=1, max_length=128)
    pose_recipe_namespace: str = Field(min_length=1, max_length=128)
    frame_selection_recipe_version: str = Field(min_length=1, max_length=128)
    requested_recipes: list[ReidFeatureRecipe] = Field(min_length=1)

    @model_validator(mode="after")
    def unique_modalities(self) -> ReidFeatureJobRequest:
        modalities = [recipe.modality for recipe in self.requested_recipes]
        if len(modalities) != len(set(modalities)):
            raise ValueError("requested ReID modalities must be unique")
        return self


class ReidAssociationRecipe(StrictModel):
    namespace: str = Field(min_length=1, max_length=128)
    candidate_modalities: list[Literal["DINO", "OSNET", "KPR", "KPR_PROMPT", "JERSEY_VLM"]] = Field(
        min_length=1
    )
    same_clip_grouping: bool
    allow_abstention: Literal[True]
    manual_assignment_precedence: Literal[True]


class ReidAssociationJobRequest(StrictModel):
    schema_version: Literal["1.1.0"]
    provider_job_id: str = Field(min_length=1, max_length=128)
    association_run_id: str = Field(min_length=1, max_length=128)
    match_id: str = Field(min_length=1, max_length=128)
    evidence_set_id: str = Field(min_length=1, max_length=128)
    eligible_tracklet_ids: list[str] = Field(min_length=1)
    evidence_result_artifact_id: str = Field(min_length=1, max_length=128)
    bank_snapshot_id: str = Field(min_length=1, max_length=128)
    bank_snapshot_artifact_id: str = Field(min_length=1, max_length=128)
    roster_snapshot_artifact_id: str = Field(min_length=1, max_length=128)
    recipe: ReidAssociationRecipe

    @field_validator("eligible_tracklet_ids")
    @classmethod
    def unique_tracklets(cls, value: list[str]) -> list[str]:
        if len(value) != len(set(value)):
            raise ValueError("eligible association tracklets must be unique")
        return value


class IdentityPreviewRecipe(StrictModel):
    namespace: str = Field(min_length=1, max_length=128)
    output_format: Literal["ANIMATED_WEBP", "MP4"]
    target_width: int = Field(ge=96, le=1024)
    crop_padding_ratio: float = Field(ge=0, le=1)
    frame_duration_ms: int = Field(ge=40, le=2000)


class IdentityPreviewJobRequest(StrictModel):
    schema_version: Literal["1.1.0"]
    provider_job_id: str = Field(min_length=1, max_length=128)
    preview_id: str = Field(min_length=1, max_length=128)
    analysis_run_id: str = Field(min_length=1, max_length=128)
    tracklet_id: str = Field(min_length=1, max_length=128)
    canonical_track_id: int = Field(ge=0)
    crop_source_manifest_artifact_id: str = Field(min_length=1, max_length=128)
    pose_manifest_artifact_id: str = Field(min_length=1, max_length=128)
    selected_frame_indices: list[str] = Field(min_length=1, max_length=96)
    recipe: IdentityPreviewRecipe

    @field_validator("selected_frame_indices")
    @classmethod
    def validate_frames(cls, value: list[str]) -> list[str]:
        frames = [_digits(item, "selected_frame_indices") for item in value]
        if frames != sorted(set(frames), key=int):
            raise ValueError("preview frame indices must be unique and strictly increasing")
        return frames


class UnavailableEvidence(StrictModel):
    kind: str = Field(min_length=1, max_length=128)
    reason_code: str = Field(min_length=1, max_length=128)
    message: str = Field(min_length=1, max_length=1000)


class AnalysisEvidenceManifest(StrictModel):
    schema_version: Literal["1.0.0"]
    analysis_run_id: str = Field(min_length=1, max_length=128)
    match_id: str = Field(min_length=1, max_length=128)
    rally_submission_id: str = Field(min_length=1, max_length=128)
    clip_asset_id: str = Field(min_length=1, max_length=128)
    analysis_data_artifact: ImmutableArtifactReference
    pose_manifest_artifact: ImmutableArtifactReference
    crop_source_manifest_artifact: ImmutableArtifactReference
    content_sha256: str = Field(pattern=r"^[A-Fa-f0-9]{64}$")
    unavailable_evidence: list[UnavailableEvidence]


class ReidVectorReference(StrictModel):
    vector_id: str = Field(min_length=1, max_length=128)
    modality: DescriptorModality
    model_namespace: str = Field(min_length=1, max_length=128)
    dimension: int = Field(ge=1, le=65536)
    normalization: Literal["NONE", "L2"]
    distance: Literal["COSINE", "EUCLIDEAN"]
    byte_offset: str
    byte_length: str
    sha256: str = Field(pattern=r"^[A-Fa-f0-9]{64}$")
    source_frame_indices: list[str] = Field(min_length=1)

    @field_validator("byte_offset", "byte_length")
    @classmethod
    def validate_uint(cls, value: str, info: Any) -> str:
        return _digits(value, info.field_name)

    @field_validator("source_frame_indices")
    @classmethod
    def validate_frames(cls, value: list[str]) -> list[str]:
        frames = [_digits(item, "source_frame_indices") for item in value]
        if len(frames) != len(set(frames)):
            raise ValueError("source_frame_indices must be unique")
        return frames

    @model_validator(mode="after")
    def float32_length(self) -> ReidVectorReference:
        if int(self.byte_length) != self.dimension * 4:
            raise ValueError("descriptor byte_length must equal dimension * 4")
        return self


class JerseyVlmEvidence(StrictModel):
    model_namespace: str = Field(min_length=1, max_length=128)
    raw_response_key: str = Field(min_length=1, max_length=128)
    raw_response_sha256: str = Field(pattern=r"^[A-Fa-f0-9]{64}$")
    candidate_numbers: list[int]
    selected_frame_indices: list[str]

    @field_validator("candidate_numbers")
    @classmethod
    def validate_numbers(cls, value: list[int]) -> list[int]:
        if any(number < 0 or number > 99 for number in value) or len(value) != len(set(value)):
            raise ValueError("candidate_numbers must be unique values from 0 through 99")
        return value

    @field_validator("selected_frame_indices")
    @classmethod
    def validate_frames(cls, value: list[str]) -> list[str]:
        frames = [_digits(item, "selected_frame_indices") for item in value]
        if len(frames) != len(set(frames)):
            raise ValueError("selected_frame_indices must be unique")
        return frames


class ReidTrackletEvidence(StrictModel):
    tracklet_id: str = Field(min_length=1, max_length=128)
    canonical_track_id: int = Field(ge=0)
    track_id_aliases: list[int] = Field(min_length=1)
    court_side: Literal["LEFT", "RIGHT", "UNKNOWN"]
    first_frame_index: str
    last_frame_index: str
    cannot_link_tracklet_ids: list[str]
    vectors: list[ReidVectorReference]
    jersey_vlm: JerseyVlmEvidence | None = None

    @field_validator("first_frame_index", "last_frame_index")
    @classmethod
    def validate_frame(cls, value: str, info: Any) -> str:
        return _digits(value, info.field_name)

    @model_validator(mode="after")
    def tracklet_invariants(self) -> ReidTrackletEvidence:
        if self.canonical_track_id not in self.track_id_aliases:
            raise ValueError("canonical_track_id must be one of track_id_aliases")
        if len(self.track_id_aliases) != len(set(self.track_id_aliases)):
            raise ValueError("track_id_aliases must be unique")
        if len(self.cannot_link_tracklet_ids) != len(set(self.cannot_link_tracklet_ids)):
            raise ValueError("cannot_link_tracklet_ids must be unique")
        if int(self.last_frame_index) < int(self.first_frame_index):
            raise ValueError("tracklet frame range is reversed")
        modalities = [vector.modality for vector in self.vectors]
        if len(modalities) != len(set(modalities)):
            raise ValueError("tracklet vectors must contain at most one vector per modality")
        return self


class ReidFeatureUnavailableEvidence(StrictModel):
    tracklet_id: str = Field(min_length=1, max_length=128)
    modality: Literal["DINO", "OSNET", "KPR", "KPR_PROMPT", "JERSEY_VLM"]
    reason_code: str = Field(min_length=1, max_length=128)
    message: str = Field(min_length=1, max_length=1000)


class ReidFeatureResult(StrictModel):
    schema_version: Literal["1.0.0"]
    provider_job_id: str = Field(min_length=1, max_length=128)
    evidence_set_id: str = Field(min_length=1, max_length=128)
    analysis_run_id: str = Field(min_length=1, max_length=128)
    match_id: str = Field(min_length=1, max_length=128)
    status: Literal["READY", "PARTIAL"]
    descriptor_artifact: ImmutableArtifactReference
    jersey_vlm_response_artifact: ImmutableArtifactReference | None = None
    tracklets: list[ReidTrackletEvidence]
    unavailable_evidence: list[ReidFeatureUnavailableEvidence]
    content_sha256: str = Field(pattern=r"^[A-Fa-f0-9]{64}$")

    @model_validator(mode="after")
    def artifact_shape(self) -> ReidFeatureResult:
        if self.descriptor_artifact.kind != "REID_DESCRIPTOR_BUNDLE":
            raise ValueError("descriptor artifact must be REID_DESCRIPTOR_BUNDLE")
        has_jersey = any(tracklet.jersey_vlm is not None for tracklet in self.tracklets)
        if has_jersey != (self.jersey_vlm_response_artifact is not None):
            raise ValueError("jersey evidence requires exactly one raw response artifact")
        if self.jersey_vlm_response_artifact is not None:
            artifact = self.jersey_vlm_response_artifact
            if artifact.kind != "JERSEY_VLM_RESPONSE":
                raise ValueError("jersey response artifact must be JERSEY_VLM_RESPONSE")
        return self


class ReidJerseyVlmRawResponse(StrictModel):
    response_key: str = Field(min_length=1, max_length=128)
    tracklet_id: str = Field(min_length=1, max_length=128)
    model_namespace: str = Field(min_length=1, max_length=128)
    prompt_sha256: str = Field(pattern=r"^[A-Fa-f0-9]{64}$")
    selected_frame_indices: list[str]
    raw_response: str = Field(max_length=262144)
    raw_response_sha256: str = Field(pattern=r"^[A-Fa-f0-9]{64}$")
    candidate_numbers: list[int]
    abstained: bool
    reason: str | None = Field(default=None, min_length=1, max_length=1000)

    @field_validator("selected_frame_indices")
    @classmethod
    def validate_frames(cls, value: list[str]) -> list[str]:
        frames = [_digits(item, "selected_frame_indices") for item in value]
        if len(frames) != len(set(frames)):
            raise ValueError("selected_frame_indices must be unique")
        return frames

    @field_validator("candidate_numbers")
    @classmethod
    def validate_candidates(cls, value: list[int]) -> list[int]:
        if any(number < 0 or number > 99 for number in value) or len(value) != len(set(value)):
            raise ValueError("candidate_numbers must be unique values from 0 through 99")
        return value

    @model_validator(mode="after")
    def response_hash_and_abstention(self) -> ReidJerseyVlmRawResponse:
        if (
            sha256(self.raw_response.encode("utf-8")).hexdigest()
            != self.raw_response_sha256.lower()
        ):
            raise ValueError("raw_response_sha256 does not match the exact raw response text")
        if self.abstained and self.candidate_numbers:
            raise ValueError("an abstained VLM response cannot expose normalized candidates")
        if not self.abstained and not self.candidate_numbers:
            raise ValueError("a non-abstained VLM response requires at least one candidate")
        return self


class ReidJerseyVlmResponseBundle(StrictModel):
    schema_version: Literal["1.0.0"]
    provider_job_id: str = Field(min_length=1, max_length=128)
    evidence_set_id: str = Field(min_length=1, max_length=128)
    responses: list[ReidJerseyVlmRawResponse]
    content_sha256: str = Field(pattern=r"^[A-Fa-f0-9]{64}$")

    @model_validator(mode="after")
    def unique_response_keys(self) -> ReidJerseyVlmResponseBundle:
        keys = [response.response_key for response in self.responses]
        tracklets = [response.tracklet_id for response in self.responses]
        if len(keys) != len(set(keys)) or len(tracklets) != len(set(tracklets)):
            raise ValueError("VLM response keys and tracklets must be unique")
        return self


class ReidBankPosition(StrictModel):
    set_number: int = Field(ge=1)
    rally_ordinal: int = Field(ge=0)


class ReidBankArtifact(StrictModel):
    artifact_id: str = Field(min_length=1, max_length=128)
    sha256: str = Field(pattern=r"^[A-Fa-f0-9]{64}$")
    byte_length: str

    @field_validator("byte_length")
    @classmethod
    def validate_byte_length(cls, value: str) -> str:
        return _digits(value, "byte_length")


class ReidBankCluster(StrictModel):
    person_cluster_id: str = Field(min_length=1, max_length=128)
    roster_entry_id: str | None = Field(default=None, min_length=1, max_length=128)


class ReidBankVector(StrictModel):
    vector_id: str = Field(min_length=1, max_length=128)
    artifact_id: str = Field(min_length=1, max_length=128)
    modality: Literal["DINO", "OSNET", "KPR", "KPR_PROMPT"]
    model_namespace: str = Field(min_length=1, max_length=128)
    dimension: int = Field(ge=1, le=65536)
    normalization: Literal["NONE", "L2"]
    distance: Literal["COSINE", "EUCLIDEAN"]
    byte_offset: str
    byte_length: str
    sha256: str = Field(pattern=r"^[A-Fa-f0-9]{64}$")

    @field_validator("byte_offset", "byte_length")
    @classmethod
    def validate_uint(cls, value: str, info: Any) -> str:
        return _digits(value, info.field_name)

    @model_validator(mode="after")
    def float32_length(self) -> ReidBankVector:
        if int(self.byte_length) != self.dimension * 4:
            raise ValueError("bank vector byte_length must equal dimension * 4")
        return self


class ReidBankMembership(StrictModel):
    membership_id: str = Field(min_length=1, max_length=128)
    person_cluster_id: str = Field(min_length=1, max_length=128)
    tracklet_id: str = Field(min_length=1, max_length=128)
    vector_ids: list[str] = Field(min_length=1)
    evidence_state: Literal["CONFIRMED"]
    evidence_role: Literal["POSITIVE", "NEGATIVE"]
    weight: float = Field(gt=0, le=1)
    source_revision: str
    roster_entry_id: str | None = Field(default=None, min_length=1, max_length=128)

    @field_validator("source_revision")
    @classmethod
    def validate_revision(cls, value: str) -> str:
        return _digits(value, "source_revision")


class ReidCannotLink(StrictModel):
    left_tracklet_id: str = Field(min_length=1, max_length=128)
    right_tracklet_id: str = Field(min_length=1, max_length=128)
    reason: Literal["CO_VISIBILITY", "HUMAN_REJECTION", "ROSTER_CONSTRAINT"]

    @model_validator(mode="after")
    def different_tracklets(self) -> ReidCannotLink:
        if self.left_tracklet_id == self.right_tracklet_id:
            raise ValueError("cannot-link tracklets must be different")
        return self


class ReidBankSnapshot(StrictModel):
    schema_version: Literal["1.1.0"]
    bank_snapshot_id: str = Field(min_length=1, max_length=128)
    match_id: str = Field(min_length=1, max_length=128)
    team_id: str = Field(min_length=1, max_length=128)
    revision: str
    as_of_position: ReidBankPosition
    clusters: list[ReidBankCluster]
    evidence_artifacts: list[ReidBankArtifact]
    vectors: list[ReidBankVector]
    memberships: list[ReidBankMembership]
    cannot_links: list[ReidCannotLink]
    content_sha256: str = Field(pattern=r"^[A-Fa-f0-9]{64}$")

    @field_validator("revision")
    @classmethod
    def validate_revision(cls, value: str) -> str:
        return _digits(value, "revision")

    @model_validator(mode="after")
    def reference_integrity(self) -> ReidBankSnapshot:
        artifact_ids = [artifact.artifact_id for artifact in self.evidence_artifacts]
        cluster_ids = [cluster.person_cluster_id for cluster in self.clusters]
        roster_ids = [
            cluster.roster_entry_id for cluster in self.clusters if cluster.roster_entry_id
        ]
        vector_ids = [vector.vector_id for vector in self.vectors]
        if len(artifact_ids) != len(set(artifact_ids)):
            raise ValueError("bank evidence artifact ids must be unique")
        if len(cluster_ids) != len(set(cluster_ids)):
            raise ValueError("bank person cluster ids must be unique")
        if len(roster_ids) != len(set(roster_ids)):
            raise ValueError("bank roster entries must map to at most one cluster")
        if len(vector_ids) != len(set(vector_ids)):
            raise ValueError("bank vector ids must be unique")
        if any(vector.artifact_id not in artifact_ids for vector in self.vectors):
            raise ValueError("bank vector references an unknown evidence artifact")
        cluster_id_set = set(cluster_ids)
        vector_id_set = set(vector_ids)
        for membership in self.memberships:
            if membership.person_cluster_id not in cluster_id_set:
                raise ValueError("bank membership references an unknown person cluster")
            if not set(membership.vector_ids).issubset(vector_id_set):
                raise ValueError("bank membership references an unknown vector")
        return self


class ReidAssociationScore(StrictModel):
    component: Literal["DINO", "OSNET", "KPR", "KPR_PROMPT", "JERSEY_VLM", "CONSTRAINT"]
    value: float
    model_namespace: str = Field(min_length=1, max_length=128)


class ReidAssociationCandidate(StrictModel):
    candidate_key: str = Field(min_length=1, max_length=128)
    person_cluster_id: str | None = Field(default=None, min_length=1, max_length=128)
    roster_entry_id: str | None = Field(default=None, min_length=1, max_length=128)
    rank: int = Field(ge=1)
    confidence: float | None = Field(default=None, ge=0, le=1)
    scores: list[ReidAssociationScore]


class ReidAssociationDecision(StrictModel):
    tracklet_id: str = Field(min_length=1, max_length=128)
    group_key: str = Field(min_length=1, max_length=128)
    association_state: Literal["RESOLVED", "UNRESOLVED", "NEEDS_REVIEW"]
    selected_person_cluster_id: str | None = Field(default=None, min_length=1, max_length=128)
    selected_roster_entry_id: str | None = Field(default=None, min_length=1, max_length=128)
    candidates: list[ReidAssociationCandidate]
    unresolved_reason: str | None = Field(default=None, max_length=1000)

    @model_validator(mode="after")
    def decision_shape(self) -> ReidAssociationDecision:
        if self.association_state == "RESOLVED":
            if self.selected_person_cluster_id is None or self.unresolved_reason is not None:
                raise ValueError("resolved association requires a selected cluster and no reason")
        elif self.unresolved_reason is None:
            raise ValueError("unresolved/review association requires a reason")
        ranks = [candidate.rank for candidate in self.candidates]
        if ranks != list(range(1, len(ranks) + 1)):
            raise ValueError("association candidates must have contiguous rank order")
        return self


class ReidAssociationResult(StrictModel):
    schema_version: Literal["1.0.0"]
    provider_job_id: str = Field(min_length=1, max_length=128)
    association_run_id: str = Field(min_length=1, max_length=128)
    evidence_set_id: str = Field(min_length=1, max_length=128)
    bank_snapshot_id: str = Field(min_length=1, max_length=128)
    status: Literal["COMPLETED", "NEEDS_REVIEW"]
    decisions: list[ReidAssociationDecision]
    content_sha256: str = Field(pattern=r"^[A-Fa-f0-9]{64}$")


class IdentityPreviewMediaArtifact(StrictModel):
    artifact_id: str = Field(min_length=1, max_length=128)
    kind: Literal["IDENTITY_PREVIEW"]
    sha256: str = Field(pattern=r"^[A-Fa-f0-9]{64}$")
    byte_length: str
    content_type: Literal["image/webp", "video/mp4"]

    @field_validator("byte_length")
    @classmethod
    def validate_byte_length(cls, value: str) -> str:
        return _digits(value, "byte_length")


class IdentityPreviewResult(StrictModel):
    schema_version: Literal["1.0.0"]
    provider_job_id: str = Field(min_length=1, max_length=128)
    preview_id: str = Field(min_length=1, max_length=128)
    tracklet_id: str = Field(min_length=1, max_length=128)
    recipe_namespace: str = Field(min_length=1, max_length=128)
    media_artifact: IdentityPreviewMediaArtifact
    source_frame_indices: list[str] = Field(min_length=1, max_length=96)
    start_frame_index: str
    end_frame_index: str
    width: int = Field(ge=1)
    height: int = Field(ge=1)
    frame_count: int = Field(ge=1, le=96)
    duration_ms: int = Field(ge=1)
    content_sha256: str = Field(pattern=r"^[A-Fa-f0-9]{64}$")

    @field_validator("source_frame_indices")
    @classmethod
    def validate_source_frames(cls, value: list[str]) -> list[str]:
        frames = [_digits(item, "source_frame_indices") for item in value]
        if frames != sorted(set(frames), key=int):
            raise ValueError("preview source frames must be unique and strictly increasing")
        return frames

    @field_validator("start_frame_index", "end_frame_index")
    @classmethod
    def validate_boundary(cls, value: str, info: Any) -> str:
        return _digits(value, info.field_name)

    @model_validator(mode="after")
    def preview_shape(self) -> IdentityPreviewResult:
        if self.frame_count != len(self.source_frame_indices):
            raise ValueError("preview frame_count must equal source frame count")
        if self.start_frame_index != self.source_frame_indices[0]:
            raise ValueError("preview start frame must be the first source frame")
        if self.end_frame_index != self.source_frame_indices[-1]:
            raise ValueError("preview end frame must be the last source frame")
        return self
