import json
from collections.abc import Iterable, Mapping
from importlib.resources import files
from math import isfinite
from pathlib import Path
from typing import TYPE_CHECKING, Any

import flatbuffers

if TYPE_CHECKING:
    from .models import AIJobRequest, AnalysisDomainData

FILE_IDENTIFIER = b"VAD1"


def _domain_json(domain: "AnalysisDomainData") -> str:
    """Serialize the exact JSON Schema wire shape embedded in VAD1."""
    payload = domain.model_dump(mode="json", exclude_none=True)
    contact_events = payload.get("contact_events")
    if isinstance(contact_events, list):
        for index, event in enumerate(domain.contact_events):
            # This is the one nullable field that is required to distinguish a
            # human anchor from an AI-created contact with no source key point.
            if event.source_key_point_id is None:
                contact_events[index]["source_key_point_id"] = None
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def analysis_data_schema_path() -> Path:
    return Path(str(files("volleyball_monitoring_ai.schemas").joinpath("analysis-data.fbs")))


def validate_analysis_data_bytes(data: bytes) -> None:
    if len(data) < 8 or data[4:8] != FILE_IDENTIFIER:
        raise ValueError("analysis data is not a VAD1 FlatBuffer")


def _scalar_vector(builder: flatbuffers.Builder, values: list[int], width: int) -> int:
    builder.StartVector(width, len(values), width)
    prepend = {1: builder.PrependUint8, 2: builder.PrependUint16, 4: builder.PrependUint32}[width]
    for value in reversed(values):
        prepend(value)
    return builder.EndVector()


def _empty_frame_positions(builder: flatbuffers.Builder, frame_count: int) -> int:
    builder.StartVector(4, frame_count, 2)
    for _ in range(frame_count):
        builder.Prep(2, 4)
        builder.PrependUint16(0)
        builder.PrependUint16(0)
    return builder.EndVector()


def _frame_bbox_vector(
    builder: flatbuffers.Builder, values: list[tuple[int, int, int, int]]
) -> int:
    builder.StartVector(8, len(values), 2)
    for x1, y1, x2, y2 in reversed(values):
        builder.Prep(2, 8)
        builder.PrependUint16(y2)
        builder.PrependUint16(x2)
        builder.PrependUint16(y1)
        builder.PrependUint16(x1)
    return builder.EndVector()


def _frame_position_vector(builder: flatbuffers.Builder, values: list[tuple[int, int]]) -> int:
    builder.StartVector(4, len(values), 2)
    for x, y in reversed(values):
        builder.Prep(2, 4)
        builder.PrependUint16(y)
        builder.PrependUint16(x)
    return builder.EndVector()


def _court_position_vector(builder: flatbuffers.Builder, values: list[tuple[float, float]]) -> int:
    builder.StartVector(8, len(values), 4)
    for x, y in reversed(values):
        builder.Prep(4, 8)
        builder.PrependFloat32(y)
        builder.PrependFloat32(x)
    return builder.EndVector()


def _number(value: Any, *, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be numeric")
    result = float(value)
    if not isfinite(result):
        raise ValueError(f"{name} must be finite")
    return result


def _position(value: Any, *, name: str) -> tuple[float, float]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{name} must be an object")
    return _number(value.get("x"), name=f"{name}.x"), _number(value.get("y"), name=f"{name}.y")


def _bbox(value: Any) -> tuple[float, float, float, float]:
    if not isinstance(value, Mapping):
        raise ValueError("frame_bbox must be an object")
    result = tuple(
        _number(value.get(key), name=f"frame_bbox.{key}") for key in ("x1", "y1", "x2", "y2")
    )
    if result[0] > result[2] or result[1] > result[3]:
        raise ValueError("frame_bbox coordinates must be ordered")
    return result  # type: ignore[return-value]


def _confidence(value: Any, *, name: str) -> int:
    if value is None:
        return 255
    number = _number(value, name=name)
    if not 0.0 <= number <= 1.0:
        raise ValueError(f"{name} must be within [0,1]")
    return round(number * 254)


def build_analysis_data(
    job: "AIJobRequest",
    *,
    domain: "AnalysisDomainData",
    frame_records: Iterable[Mapping[str, Any]],
    ball_positions: Mapping[int, Mapping[str, Any]],
    court_keypoints: Mapping[int, Iterable[Mapping[str, Any]]] | None = None,
    action_taxonomy_id: str = "",
    action_taxonomy_version: str = "",
) -> bytes:
    """Build the only authoritative VAD1 artifact from provider observations.

    Video-space values are quantized to U16. AI-owned ``court_pos`` values are
    written as finite float32 values without projection or clamping.
    """

    total_frames = int(job.clip.video.total_frames)
    per_frame: list[list[Mapping[str, Any]]] = [[] for _ in range(total_frames)]
    for record in frame_records:
        frame_index = int(record.get("frame_index", -1))
        players = record.get("players")
        if frame_index < 0 or frame_index >= total_frames or not isinstance(players, list):
            raise ValueError("tracking record is outside the canonical clip")
        per_frame[frame_index] = sorted(players, key=lambda item: int(item["track_id"]))

    frame_offsets = [0]
    track_ids: list[int] = []
    frame_bboxes: list[tuple[int, int, int, int]] = []
    frame_foot_positions: list[tuple[int, int]] = []
    court_positions: list[tuple[float, float]] = []
    player_flags: list[int] = []
    player_confidences: list[int] = []
    action_label_ids: list[int] = []
    action_confidences: list[int] = []
    action_labels: list[str] = []
    action_label_lookup: dict[str, int] = {}
    for players in per_frame:
        for player in players:
            track_id = int(player.get("track_id", -1))
            if track_id < 0 or track_id >= 65_535:
                raise ValueError("track_id is outside the VAD1 ushort range")
            raw_bbox = _bbox(player.get("frame_bbox"))
            raw_foot = _position(player.get("frame_foot_pos"), name="frame_foot_pos")
            court_value = player.get("court_pos")
            raw_court = (
                (0.0, 0.0) if court_value is None else _position(court_value, name="court_pos")
            )
            track_ids.append(track_id)
            frame_bboxes.append(tuple(quantize_frame_coordinate(value) for value in raw_bbox))
            frame_foot_positions.append(
                tuple(quantize_frame_coordinate(value) for value in raw_foot)
            )
            court_positions.append(raw_court)
            player_flags.append(0b011 if court_value is None else 0b111)
            player_confidences.append(
                _confidence(player.get("confidence"), name="player.confidence")
            )
            action_label = player.get("action_label")
            if action_label is None:
                action_label_ids.append(65_535)
                action_confidences.append(255)
            else:
                if not isinstance(action_label, str) or not action_label.strip():
                    raise ValueError("player.action_label must be a non-empty string")
                normalized_action = action_label.strip()
                action_id = action_label_lookup.get(normalized_action)
                if action_id is None:
                    action_id = len(action_labels)
                    if action_id >= 65_535:
                        raise ValueError("too many AnalysisData action labels")
                    action_label_lookup[normalized_action] = action_id
                    action_labels.append(normalized_action)
                action_label_ids.append(action_id)
                action_confidences.append(
                    _confidence(player.get("action_confidence"), name="player.action_confidence")
                )
        frame_offsets.append(len(track_ids))

    ball_frame_positions: list[tuple[int, int]] = []
    ball_flags: list[int] = []
    ball_confidences: list[int] = []
    for frame_index in range(total_frames):
        ball = ball_positions.get(frame_index)
        if ball is None:
            ball_frame_positions.append((0, 0))
            ball_flags.append(0)
        else:
            x, y = _position(ball, name="ball.frame_pos")
            ball_frame_positions.append(
                (quantize_frame_coordinate(x), quantize_frame_coordinate(y))
            )
            ball_flags.append(1)
        ball_confidences.append(
            _confidence(ball.get("confidence") if ball else None, name="ball.confidence")
        )

    court_keypoint_frame_offsets = [0]
    court_keypoint_ids: list[int] = []
    court_keypoint_positions: list[tuple[int, int]] = []
    court_keypoint_confidences: list[int] = []
    source_court_keypoints = court_keypoints or {}
    for frame_index in range(total_frames):
        keypoints = sorted(
            source_court_keypoints.get(frame_index, ()),
            key=lambda item: int(item.get("keypoint_id", item.get("index", -1))),
        )
        for keypoint in keypoints:
            keypoint_id = int(keypoint.get("keypoint_id", keypoint.get("index", -1)))
            if keypoint_id < 0 or keypoint_id >= 65_535:
                raise ValueError("court keypoint id is outside the VAD1 ushort range")
            x, y = _position(keypoint.get("frame_pos"), name="court_keypoint.frame_pos")
            if not 0.0 <= x <= 1.0 or not 0.0 <= y <= 1.0:
                continue
            court_keypoint_ids.append(keypoint_id)
            court_keypoint_positions.append(
                (quantize_frame_coordinate(x), quantize_frame_coordinate(y))
            )
            court_keypoint_confidences.append(
                _confidence(keypoint.get("confidence"), name="court_keypoint.confidence")
            )
        court_keypoint_frame_offsets.append(len(court_keypoint_ids))

    builder = flatbuffers.Builder(max(1024, len(track_ids) * 36 + total_frames * 12))
    strings = {
        "ai_job_id": builder.CreateString(job.ai_job_id),
        "submission_id": builder.CreateString(job.rally_submission_id),
        "rally_id": builder.CreateString(job.rally_id),
        "match_id": builder.CreateString(job.match_id),
        "clip_asset_id": builder.CreateString(job.clip.clip_asset_id),
        "analysis_id": builder.CreateString(domain.analysis_id),
        "analysis_version": builder.CreateString(domain.analysis_version),
        "taxonomy_id": builder.CreateString(action_taxonomy_id),
        "taxonomy_version": builder.CreateString(action_taxonomy_version),
        "domain_json": builder.CreateString(_domain_json(domain)),
        "input_clip_sha256": builder.CreateString(domain.input_clip_sha256),
        "producer_name": builder.CreateString(domain.producer.name),
        "producer_build_id": builder.CreateString(domain.producer.build_id),
        "producer_sdk_version": builder.CreateString(domain.producer.sdk_version or ""),
        "execution_manifest_json": builder.CreateString(job.analysis_plan.model_dump_json()),
    }
    empty_u32 = _scalar_vector(builder, [], 4)
    action_label_strings = [builder.CreateString(label) for label in action_labels]
    offsets_vector = _scalar_vector(builder, frame_offsets, 4)
    track_vector = _scalar_vector(builder, track_ids, 2)
    bbox_vector = _frame_bbox_vector(builder, frame_bboxes)
    foot_vector = _frame_position_vector(builder, frame_foot_positions)
    court_vector = _court_position_vector(builder, court_positions)
    player_flags_vector = _scalar_vector(builder, player_flags, 1)
    player_confidence_vector = _scalar_vector(builder, player_confidences, 1)
    action_ids_vector = _scalar_vector(builder, action_label_ids, 2)
    action_confidence_vector = _scalar_vector(builder, action_confidences, 1)
    ball_position_vector = _frame_position_vector(builder, ball_frame_positions)
    ball_flags_vector = _scalar_vector(builder, ball_flags, 1)
    ball_confidence_vector = _scalar_vector(builder, ball_confidences, 1)
    court_keypoint_offsets_vector = _scalar_vector(builder, court_keypoint_frame_offsets, 4)
    court_keypoint_ids_vector = _scalar_vector(builder, court_keypoint_ids, 2)
    court_keypoint_positions_vector = _frame_position_vector(builder, court_keypoint_positions)
    court_keypoint_confidences_vector = _scalar_vector(builder, court_keypoint_confidences, 1)
    builder.StartVector(4, len(action_label_strings), 4)
    for label in reversed(action_label_strings):
        builder.PrependUOffsetTRelative(label)
    action_labels_vector = builder.EndVector()

    builder.StartObject(40)
    builder.PrependUint32Slot(0, 10_000, 10_000)
    builder.PrependUOffsetTRelativeSlot(1, strings["ai_job_id"], 0)
    builder.PrependUOffsetTRelativeSlot(2, strings["submission_id"], 0)
    builder.PrependUOffsetTRelativeSlot(3, strings["rally_id"], 0)
    builder.PrependUOffsetTRelativeSlot(4, strings["match_id"], 0)
    builder.PrependUint64Slot(5, int(job.annotation_revision), 0)
    builder.PrependUOffsetTRelativeSlot(6, strings["clip_asset_id"], 0)
    builder.PrependUOffsetTRelativeSlot(7, strings["analysis_id"], 0)
    builder.PrependUOffsetTRelativeSlot(8, strings["analysis_version"], 0)
    builder.PrependUint32Slot(9, job.clip.video.width, 0)
    builder.PrependUint32Slot(10, job.clip.video.height, 0)
    builder.PrependUint32Slot(11, job.clip.video.fps.num, 0)
    builder.PrependUint32Slot(12, job.clip.video.fps.den, 0)
    builder.PrependUint64Slot(13, total_frames, 0)
    builder.PrependUOffsetTRelativeSlot(14, empty_u32, 0)
    builder.PrependUOffsetTRelativeSlot(15, offsets_vector, 0)
    builder.PrependUOffsetTRelativeSlot(16, track_vector, 0)
    builder.PrependUOffsetTRelativeSlot(17, bbox_vector, 0)
    builder.PrependUOffsetTRelativeSlot(18, foot_vector, 0)
    builder.PrependUOffsetTRelativeSlot(19, court_vector, 0)
    builder.PrependUOffsetTRelativeSlot(20, player_flags_vector, 0)
    builder.PrependUOffsetTRelativeSlot(21, player_confidence_vector, 0)
    builder.PrependUOffsetTRelativeSlot(22, strings["taxonomy_id"], 0)
    builder.PrependUOffsetTRelativeSlot(23, strings["taxonomy_version"], 0)
    builder.PrependUOffsetTRelativeSlot(24, action_labels_vector, 0)
    builder.PrependUOffsetTRelativeSlot(25, action_ids_vector, 0)
    builder.PrependUOffsetTRelativeSlot(26, action_confidence_vector, 0)
    builder.PrependUOffsetTRelativeSlot(27, ball_position_vector, 0)
    builder.PrependUOffsetTRelativeSlot(28, ball_flags_vector, 0)
    builder.PrependUOffsetTRelativeSlot(29, ball_confidence_vector, 0)
    builder.PrependUOffsetTRelativeSlot(30, court_keypoint_offsets_vector, 0)
    builder.PrependUOffsetTRelativeSlot(31, court_keypoint_ids_vector, 0)
    builder.PrependUOffsetTRelativeSlot(32, court_keypoint_positions_vector, 0)
    builder.PrependUOffsetTRelativeSlot(33, court_keypoint_confidences_vector, 0)
    builder.PrependUOffsetTRelativeSlot(34, strings["domain_json"], 0)
    builder.PrependUOffsetTRelativeSlot(35, strings["input_clip_sha256"], 0)
    builder.PrependUOffsetTRelativeSlot(36, strings["producer_name"], 0)
    builder.PrependUOffsetTRelativeSlot(37, strings["producer_build_id"], 0)
    builder.PrependUOffsetTRelativeSlot(38, strings["producer_sdk_version"], 0)
    builder.PrependUOffsetTRelativeSlot(39, strings["execution_manifest_json"], 0)
    root = builder.EndObject()
    builder.Finish(root, file_identifier=FILE_IDENTIFIER)
    result = bytes(builder.Output())
    validate_analysis_data_bytes(result)
    return result


def build_empty_analysis_data(job: "AIJobRequest", *, domain: "AnalysisDomainData") -> bytes:
    """Build a contract-valid VAD1 artifact containing no model detections.

    This is intended for recorded replay or baseline providers. Missing ball/player data is
    represented by zero flags, not fabricated coordinates or confidence.
    """

    total_frames = int(job.clip.video.total_frames)
    builder = flatbuffers.Builder(max(1024, total_frames * 12))
    strings = {
        "ai_job_id": builder.CreateString(job.ai_job_id),
        "submission_id": builder.CreateString(job.rally_submission_id),
        "rally_id": builder.CreateString(job.rally_id),
        "match_id": builder.CreateString(job.match_id),
        "clip_asset_id": builder.CreateString(job.clip.clip_asset_id),
        "analysis_id": builder.CreateString(domain.analysis_id),
        "analysis_version": builder.CreateString(domain.analysis_version),
        "empty": builder.CreateString(""),
        "domain_json": builder.CreateString(_domain_json(domain)),
        "input_clip_sha256": builder.CreateString(domain.input_clip_sha256),
        "producer_name": builder.CreateString(domain.producer.name),
        "producer_build_id": builder.CreateString(domain.producer.build_id),
        "producer_sdk_version": builder.CreateString(domain.producer.sdk_version or ""),
        "execution_manifest_json": builder.CreateString(job.analysis_plan.model_dump_json()),
    }
    frame_offsets = _scalar_vector(builder, [0] * (total_frames + 1), 4)
    court_keypoint_frame_offsets = _scalar_vector(builder, [0] * (total_frames + 1), 4)
    empty_u8 = _scalar_vector(builder, [], 1)
    empty_u16 = _scalar_vector(builder, [], 2)
    empty_u32 = _scalar_vector(builder, [], 4)
    empty_bbox = _scalar_vector(builder, [], 2)
    empty_frame_pos = _scalar_vector(builder, [], 2)
    empty_court_pos = _scalar_vector(builder, [], 4)
    ball_positions = _empty_frame_positions(builder, total_frames)
    ball_flags = _scalar_vector(builder, [0] * total_frames, 1)
    ball_confidences = _scalar_vector(builder, [0] * total_frames, 1)

    builder.StartObject(40)
    builder.PrependUint32Slot(0, 10_000, 10_000)
    builder.PrependUOffsetTRelativeSlot(1, strings["ai_job_id"], 0)
    builder.PrependUOffsetTRelativeSlot(2, strings["submission_id"], 0)
    builder.PrependUOffsetTRelativeSlot(3, strings["rally_id"], 0)
    builder.PrependUOffsetTRelativeSlot(4, strings["match_id"], 0)
    builder.PrependUint64Slot(5, int(job.annotation_revision), 0)
    builder.PrependUOffsetTRelativeSlot(6, strings["clip_asset_id"], 0)
    builder.PrependUOffsetTRelativeSlot(7, strings["analysis_id"], 0)
    builder.PrependUOffsetTRelativeSlot(8, strings["analysis_version"], 0)
    builder.PrependUint32Slot(9, job.clip.video.width, 0)
    builder.PrependUint32Slot(10, job.clip.video.height, 0)
    builder.PrependUint32Slot(11, job.clip.video.fps.num, 0)
    builder.PrependUint32Slot(12, job.clip.video.fps.den, 0)
    builder.PrependUint64Slot(13, total_frames, 0)
    builder.PrependUOffsetTRelativeSlot(14, empty_u32, 0)
    builder.PrependUOffsetTRelativeSlot(15, frame_offsets, 0)
    builder.PrependUOffsetTRelativeSlot(16, empty_u16, 0)
    builder.PrependUOffsetTRelativeSlot(17, empty_bbox, 0)
    builder.PrependUOffsetTRelativeSlot(18, empty_frame_pos, 0)
    builder.PrependUOffsetTRelativeSlot(19, empty_court_pos, 0)
    builder.PrependUOffsetTRelativeSlot(20, empty_u8, 0)
    builder.PrependUOffsetTRelativeSlot(21, empty_u8, 0)
    builder.PrependUOffsetTRelativeSlot(22, strings["empty"], 0)
    builder.PrependUOffsetTRelativeSlot(23, strings["empty"], 0)
    builder.PrependUOffsetTRelativeSlot(24, empty_u32, 0)
    builder.PrependUOffsetTRelativeSlot(25, empty_u16, 0)
    builder.PrependUOffsetTRelativeSlot(26, empty_u8, 0)
    builder.PrependUOffsetTRelativeSlot(27, ball_positions, 0)
    builder.PrependUOffsetTRelativeSlot(28, ball_flags, 0)
    builder.PrependUOffsetTRelativeSlot(29, ball_confidences, 0)
    builder.PrependUOffsetTRelativeSlot(30, court_keypoint_frame_offsets, 0)
    builder.PrependUOffsetTRelativeSlot(31, empty_u16, 0)
    builder.PrependUOffsetTRelativeSlot(32, empty_frame_pos, 0)
    builder.PrependUOffsetTRelativeSlot(33, empty_u8, 0)
    builder.PrependUOffsetTRelativeSlot(34, strings["domain_json"], 0)
    builder.PrependUOffsetTRelativeSlot(35, strings["input_clip_sha256"], 0)
    builder.PrependUOffsetTRelativeSlot(36, strings["producer_name"], 0)
    builder.PrependUOffsetTRelativeSlot(37, strings["producer_build_id"], 0)
    builder.PrependUOffsetTRelativeSlot(38, strings["producer_sdk_version"], 0)
    builder.PrependUOffsetTRelativeSlot(39, strings["execution_manifest_json"], 0)
    root = builder.EndObject()
    builder.Finish(root, file_identifier=FILE_IDENTIFIER)
    result = bytes(builder.Output())
    validate_analysis_data_bytes(result)
    return result


def quantize_frame_coordinate(value: float) -> int:
    if not 0 <= value <= 1:
        raise ValueError("frame coordinate outside [0,1]")
    return round(value * 65534)
