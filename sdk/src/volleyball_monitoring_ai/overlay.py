from importlib.resources import files
from pathlib import Path
from typing import TYPE_CHECKING

import flatbuffers

if TYPE_CHECKING:
    from .models import AIJobRequest

FILE_IDENTIFIER = b"VOV1"

def overlay_schema_path() -> Path:
    return Path(str(files("volleyball_monitoring_ai.schemas").joinpath("overlay.fbs")))

def validate_overlay_bytes(data: bytes) -> None:
    if len(data) < 8 or data[4:8] != FILE_IDENTIFIER:
        raise ValueError("overlay is not a VOV1 FlatBuffer")


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


def build_empty_overlay(job: "AIJobRequest", *, analysis_id: str, analysis_version: str) -> bytes:
    """Build a contract-valid VOV1 sequence containing no model detections.

    This is intended for honest fake or baseline providers. Missing ball/player data is
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
        "analysis_id": builder.CreateString(analysis_id),
        "analysis_version": builder.CreateString(analysis_version),
        "empty": builder.CreateString(""),
    }
    frame_offsets = _scalar_vector(builder, [0] * (total_frames + 1), 4)
    empty_u8 = _scalar_vector(builder, [], 1)
    empty_u16 = _scalar_vector(builder, [], 2)
    empty_u32 = _scalar_vector(builder, [], 4)
    empty_bbox = _scalar_vector(builder, [], 2)
    empty_frame_pos = _scalar_vector(builder, [], 2)
    empty_court_pos = _scalar_vector(builder, [], 4)
    ball_positions = _empty_frame_positions(builder, total_frames)
    ball_flags = _scalar_vector(builder, [0] * total_frames, 1)
    ball_confidences = _scalar_vector(builder, [0] * total_frames, 1)

    builder.StartObject(30)
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
    root = builder.EndObject()
    builder.Finish(root, file_identifier=FILE_IDENTIFIER)
    result = bytes(builder.Output())
    validate_overlay_bytes(result)
    return result

def quantize_frame_coordinate(value: float) -> int:
    if not 0 <= value <= 1: raise ValueError("frame coordinate outside [0,1]")
    return round(value * 65534)
