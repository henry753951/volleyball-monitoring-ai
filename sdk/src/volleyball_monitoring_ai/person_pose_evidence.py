from __future__ import annotations

import hashlib
from dataclasses import dataclass
from importlib.resources import files
from itertools import pairwise
from math import isfinite
from pathlib import Path
from struct import pack
from typing import Literal

import flatbuffers
from flatbuffers.number_types import Float32Flags, Int32Flags, Uint8Flags, Uint32Flags, Uint64Flags
from flatbuffers.table import Table

FILE_IDENTIFIER = b"VPE1"
SCHEMA_VERSION = "1.0.0"
KEYPOINT_COUNT = 17

PoseStatus = Literal["AVAILABLE", "NO_USABLE_BBOX", "INFERENCE_FAILED", "LOW_QUALITY"]
BboxSource = Literal["DETECTOR", "TRACKER_PROPAGATED"]

_STATUS = {"AVAILABLE": 0, "NO_USABLE_BBOX": 1, "INFERENCE_FAILED": 2, "LOW_QUALITY": 3}
_STATUS_NAME = {value: key for key, value in _STATUS.items()}
_BBOX_SOURCE = {"DETECTOR": 0, "TRACKER_PROPAGATED": 1}
_BBOX_SOURCE_NAME = {value: key for key, value in _BBOX_SOURCE.items()}


@dataclass(frozen=True, slots=True)
class PersonPoseRecord:
    track_id: int
    bbox_source: BboxSource
    frame_bbox: tuple[float, float, float, float]
    crop_transform: tuple[float, float, float, float]
    status: PoseStatus
    keypoints: tuple[tuple[float, float, float], ...] | None


@dataclass(frozen=True, slots=True)
class DecodedPersonPoseChunk:
    schema_version: str
    analysis_run_id: str
    pose_recipe_namespace: str
    start_frame_index: int
    frames: tuple[tuple[PersonPoseRecord, ...], ...]
    observation_sha256: tuple[str, ...]


def _number(value: float, name: str) -> float:
    result = float(value)
    if not isfinite(result):
        raise ValueError(f"{name} must be finite")
    return result


def _normalized(value: float, name: str) -> float:
    result = _number(value, name)
    if not 0.0 <= result <= 1.0:
        raise ValueError(f"{name} must be within normalized video space [0,1]")
    return result


def _validate_record(record: PersonPoseRecord) -> None:
    if record.track_id < 0 or record.track_id > 2_147_483_647:
        raise ValueError("pose track_id is outside int32 range")
    x1, y1, x2, y2 = (
        _normalized(value, f"frame_bbox[{index}]") for index, value in enumerate(record.frame_bbox)
    )
    if x1 > x2 or y1 > y2:
        raise ValueError("pose frame bbox coordinates must be ordered")
    for index, value in enumerate(record.crop_transform):
        _number(value, f"crop_transform[{index}]")
    if record.status == "AVAILABLE" and record.keypoints is None:
        raise ValueError("available pose requires COCO-17 keypoints")
    if record.keypoints is not None and len(record.keypoints) != KEYPOINT_COUNT:
        raise ValueError("pose keypoints must use COCO-17 order")
    for index, (x, y, confidence) in enumerate(record.keypoints or ()):
        confidence = _number(confidence, f"keypoints[{index}].confidence")
        if confidence == -1.0:
            if x != -1.0 or y != -1.0:
                raise ValueError("missing keypoints must use (-1,-1,-1), never fabricated (0,0)")
            continue
        if not 0.0 <= confidence <= 1.0:
            raise ValueError("keypoint confidence must be -1 or within [0,1]")
        _normalized(x, f"keypoints[{index}].x")
        _normalized(y, f"keypoints[{index}].y")


def _record_sha256(record: PersonPoseRecord) -> bytes:
    keypoints = record.keypoints or tuple([(-1.0, -1.0, -1.0)] * KEYPOINT_COUNT)
    digest = hashlib.sha256()
    digest.update(
        pack(
            "<iBB8f",
            record.track_id,
            _BBOX_SOURCE[record.bbox_source],
            _STATUS[record.status],
            *record.frame_bbox,
            *record.crop_transform,
        )
    )
    digest.update(
        pack(f"<{KEYPOINT_COUNT * 3}f", *(value for point in keypoints for value in point))
    )
    return digest.digest()


def person_pose_evidence_schema_path() -> Path:
    return Path(str(files("volleyball_monitoring_ai.schemas").joinpath("person-pose-evidence.fbs")))


def _scalar_vector(
    builder: flatbuffers.Builder, values: list[int], width: int, *, signed: bool = False
) -> int:
    builder.StartVector(width, len(values), width)
    if signed:
        prepend = builder.PrependInt32
    else:
        prepend = {1: builder.PrependUint8, 4: builder.PrependUint32}[width]
    for value in reversed(values):
        prepend(value)
    return builder.EndVector()


def _float_vector(builder: flatbuffers.Builder, values: list[float]) -> int:
    builder.StartVector(4, len(values), 4)
    for value in reversed(values):
        builder.PrependFloat32(value)
    return builder.EndVector()


def validate_person_pose_evidence_bytes(data: bytes) -> None:
    if len(data) < 8 or data[4:8] != FILE_IDENTIFIER:
        raise ValueError("person pose evidence is not a VPE1 FlatBuffer")
    decode_person_pose_evidence_chunk(data)


def build_person_pose_evidence_chunk(
    *,
    analysis_run_id: str,
    pose_recipe_namespace: str,
    start_frame_index: int,
    frames: list[list[PersonPoseRecord]],
) -> bytes:
    """Build one immutable, full-coverage normalized-video-space VPE1 chunk."""
    if not analysis_run_id or not pose_recipe_namespace:
        raise ValueError("analysis run and pose recipe identities are required")
    if start_frame_index < 0 or not frames:
        raise ValueError("pose chunk requires a non-negative start and at least one frame")
    flattened: list[PersonPoseRecord] = []
    frame_offsets = [0]
    for frame in frames:
        ordered = sorted(frame, key=lambda record: record.track_id)
        if len({record.track_id for record in ordered}) != len(ordered):
            raise ValueError("pose chunk contains duplicate track IDs in one frame")
        for record in ordered:
            _validate_record(record)
            flattened.append(record)
        frame_offsets.append(len(flattened))

    builder = flatbuffers.Builder(max(1_024, len(flattened) * 512))
    schema = builder.CreateString(SCHEMA_VERSION)
    analysis = builder.CreateString(analysis_run_id)
    recipe = builder.CreateString(pose_recipe_namespace)
    offsets = _scalar_vector(builder, frame_offsets, 4)
    track_ids = _scalar_vector(builder, [record.track_id for record in flattened], 4, signed=True)
    bbox_sources = _scalar_vector(
        builder, [_BBOX_SOURCE[record.bbox_source] for record in flattened], 1
    )
    bbox_columns = [
        _float_vector(builder, [record.frame_bbox[column] for record in flattened])
        for column in range(4)
    ]
    transform_columns = [
        _float_vector(builder, [record.crop_transform[column] for record in flattened])
        for column in range(4)
    ]
    statuses = _scalar_vector(builder, [_STATUS[record.status] for record in flattened], 1)
    digests = _scalar_vector(
        builder,
        [byte for record in flattened for byte in _record_sha256(record)],
        1,
    )
    padded_keypoints = [
        record.keypoints or tuple([(-1.0, -1.0, -1.0)] * KEYPOINT_COUNT) for record in flattened
    ]
    keypoint_columns = [
        _float_vector(
            builder,
            [point[column] for keypoints in padded_keypoints for point in keypoints],
        )
        for column in range(3)
    ]

    builder.StartObject(21)
    builder.PrependUOffsetTRelativeSlot(0, schema, 0)
    builder.PrependUOffsetTRelativeSlot(1, analysis, 0)
    builder.PrependUOffsetTRelativeSlot(2, recipe, 0)
    builder.PrependUint64Slot(3, start_frame_index, 0)
    builder.PrependUint32Slot(4, len(frames), 0)
    builder.PrependUOffsetTRelativeSlot(5, offsets, 0)
    builder.PrependUOffsetTRelativeSlot(6, track_ids, 0)
    builder.PrependUOffsetTRelativeSlot(7, bbox_sources, 0)
    for slot, vector in enumerate(bbox_columns, start=8):
        builder.PrependUOffsetTRelativeSlot(slot, vector, 0)
    for slot, vector in enumerate(transform_columns, start=12):
        builder.PrependUOffsetTRelativeSlot(slot, vector, 0)
    builder.PrependUOffsetTRelativeSlot(16, statuses, 0)
    builder.PrependUOffsetTRelativeSlot(17, digests, 0)
    for slot, vector in enumerate(keypoint_columns, start=18):
        builder.PrependUOffsetTRelativeSlot(slot, vector, 0)
    root = builder.EndObject()
    builder.Finish(root, file_identifier=FILE_IDENTIFIER)
    result = bytes(builder.Output())
    validate_person_pose_evidence_bytes(result)
    return result


def _root_table(data: bytes) -> Table:
    root = int.from_bytes(data[0:4], "little")
    if root <= 0 or root >= len(data):
        raise ValueError("person pose evidence root offset is invalid")
    return Table(bytearray(data), root)


def _offset(table: Table, slot: int) -> int:
    return table.Offset(4 + slot * 2)


def _string(table: Table, slot: int) -> str:
    offset = _offset(table, slot)
    if offset == 0:
        return ""
    return bytes(table.String(offset + table.Pos)).decode()


def _scalar(table: Table, slot: int, flags: object, default: int = 0) -> int:
    offset = _offset(table, slot)
    return default if offset == 0 else int(table.Get(flags, offset + table.Pos))  # type: ignore[arg-type]


def _vector(table: Table, slot: int, flags: object) -> list[int | float]:
    offset = _offset(table, slot)
    if offset == 0:
        return []
    start = table.Vector(offset)
    length = table.VectorLen(offset)
    width = int(flags.bytewidth)  # type: ignore[attr-defined]
    return [table.Get(flags, start + index * width) for index in range(length)]  # type: ignore[arg-type]


def decode_person_pose_evidence_chunk(data: bytes) -> DecodedPersonPoseChunk:
    if len(data) < 8 or data[4:8] != FILE_IDENTIFIER:
        raise ValueError("person pose evidence is not a VPE1 FlatBuffer")
    table = _root_table(data)
    schema = _string(table, 0)
    analysis_run_id = _string(table, 1)
    pose_recipe_namespace = _string(table, 2)
    start_frame_index = _scalar(table, 3, Uint64Flags)
    frame_count = _scalar(table, 4, Uint32Flags)
    offsets = [int(value) for value in _vector(table, 5, Uint32Flags)]
    track_ids = [int(value) for value in _vector(table, 6, Int32Flags)]
    bbox_sources = [int(value) for value in _vector(table, 7, Uint8Flags)]
    bbox_columns = [
        [float(value) for value in _vector(table, slot, Float32Flags)] for slot in range(8, 12)
    ]
    transform_columns = [
        [float(value) for value in _vector(table, slot, Float32Flags)] for slot in range(12, 16)
    ]
    statuses = [int(value) for value in _vector(table, 16, Uint8Flags)]
    digest_bytes = [int(value) for value in _vector(table, 17, Uint8Flags)]
    keypoint_columns = [
        [float(value) for value in _vector(table, slot, Float32Flags)] for slot in range(18, 21)
    ]
    observation_count = len(track_ids)
    if (
        schema != SCHEMA_VERSION
        or not analysis_run_id
        or not pose_recipe_namespace
        or frame_count < 1
        or len(offsets) != frame_count + 1
        or offsets[0] != 0
        or offsets[-1] != observation_count
        or any(left > right for left, right in pairwise(offsets))
        or any(len(column) != observation_count for column in bbox_columns + transform_columns)
        or len(bbox_sources) != observation_count
        or len(statuses) != observation_count
        or len(digest_bytes) != observation_count * 32
        or any(len(column) != observation_count * KEYPOINT_COUNT for column in keypoint_columns)
    ):
        raise ValueError("person pose evidence columns are inconsistent")

    records: list[PersonPoseRecord] = []
    digests: list[str] = []
    for index, track_id in enumerate(track_ids):
        try:
            bbox_source = _BBOX_SOURCE_NAME[bbox_sources[index]]
            status = _STATUS_NAME[statuses[index]]
        except KeyError as error:
            raise ValueError("person pose evidence enum value is invalid") from error
        keypoints = tuple(
            (
                keypoint_columns[0][index * KEYPOINT_COUNT + keypoint],
                keypoint_columns[1][index * KEYPOINT_COUNT + keypoint],
                keypoint_columns[2][index * KEYPOINT_COUNT + keypoint],
            )
            for keypoint in range(KEYPOINT_COUNT)
        )
        record = PersonPoseRecord(
            track_id=track_id,
            bbox_source=bbox_source,  # type: ignore[arg-type]
            frame_bbox=tuple(column[index] for column in bbox_columns),  # type: ignore[arg-type]
            crop_transform=tuple(column[index] for column in transform_columns),  # type: ignore[arg-type]
            status=status,  # type: ignore[arg-type]
            keypoints=None if all(point[2] == -1.0 for point in keypoints) else keypoints,
        )
        _validate_record(record)
        digest = bytes(digest_bytes[index * 32 : (index + 1) * 32])
        if digest != _record_sha256(record):
            raise ValueError("person pose observation hash mismatch")
        records.append(record)
        digests.append(digest.hex())

    frames: list[tuple[PersonPoseRecord, ...]] = []
    for index in range(frame_count):
        frame = tuple(records[offsets[index] : offsets[index + 1]])
        if tuple(record.track_id for record in frame) != tuple(
            sorted(record.track_id for record in frame)
        ):
            raise ValueError("person pose records are not ordered by track ID")
        frames.append(frame)
    return DecodedPersonPoseChunk(
        schema_version=schema,
        analysis_run_id=analysis_run_id,
        pose_recipe_namespace=pose_recipe_namespace,
        start_frame_index=start_frame_index,
        frames=tuple(frames),
        observation_sha256=tuple(digests),
    )
