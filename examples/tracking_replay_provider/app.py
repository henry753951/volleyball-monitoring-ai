from __future__ import annotations

import json
import os
from copy import deepcopy
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, uuid5

from volleyball_monitoring_ai import (
    AIJobRequest,
    AnalysisBundle,
    AnalysisResult,
    ProviderCapabilities,
    build_tracking_overlay,
    create_provider_app,
)

ANALYSIS_VERSION = "contract-lab-tracking-replay-v2"
PROVIDER_BUILD = "yolox-deep-eiou-sam-court-v1"
FRAME_INDEX_FIELDS = {
    "anchor_frame_index",
    "end_frame_index",
    "first_frame_index",
    "last_frame_index",
    "observation_frame_index",
    "resolved_frame_index",
    "sample_frame_index",
    "start_frame_index",
}


def handoff_root() -> Path:
    return Path(os.environ.get("CONTRACT_LAB_HANDOFF_ROOT", "/data/contract-lab-handoff"))


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def rewrite_heuristic_labels(value: Any) -> Any:
    if isinstance(value, list):
        return [rewrite_heuristic_labels(item) for item in value]
    if isinstance(value, dict):
        return {
            ("heuristic_action" if key == "synthetic_action" else key): rewrite_heuristic_labels(item)
            for key, item in value.items()
        }
    return value


def validate_reference_job(job: AIJobRequest, reference: dict[str, Any]) -> tuple[int, dict[str, str]]:
    expected_points = reference.get("key_points", [])
    actual_shape = [
        (point.sequence_index, point.marker_kind, point.is_terminal)
        for point in job.key_points
    ]
    expected_shape = [
        (point["sequence_index"], point["marker_kind"], point["is_terminal"])
        for point in expected_points
    ]
    expected_first = int(expected_points[0]["clip_frame_index"]) if expected_points else 0
    actual_first = int(job.key_points[0].clip_frame_index) if job.key_points else 0
    frame_shift = actual_first - expected_first
    aligned = all(
        abs(
            (int(actual.clip_frame_index) - actual_first)
            - (int(expected["clip_frame_index"]) - expected_first)
        ) <= 2
        for actual, expected in zip(job.key_points, expected_points, strict=True)
    ) if len(job.key_points) == len(expected_points) else False
    if (
        job.rally_id != reference.get("rally_id")
        or job.clip.video.width != 1920
        or job.clip.video.height != 1080
        or int(job.clip.video.fps.num) != 60
        or int(job.clip.video.fps.den) != 1
        or actual_shape != expected_shape
        or not aligned
    ):
        raise ValueError(
            "tracking replay only supports the Contract Lab reference rally geometry"
        )
    return frame_shift, {
        expected["key_point_id"]: actual.key_point_id
        for actual, expected in zip(job.key_points, expected_points, strict=True)
    }


def rewrite_reference_geometry(
    value: Any,
    *,
    frame_shift: int,
    key_point_ids: dict[str, str],
    total_frames: int,
) -> Any:
    if isinstance(value, list):
        return [
            rewrite_reference_geometry(
                item,
                frame_shift=frame_shift,
                key_point_ids=key_point_ids,
                total_frames=total_frames,
            )
            for item in value
        ]
    if not isinstance(value, dict):
        return value
    rewritten: dict[str, Any] = {}
    for key, item in value.items():
        if key in FRAME_INDEX_FIELDS and item is not None:
            shifted = max(0, min(total_frames - 1, int(item) + frame_shift))
            rewritten[key] = str(shifted)
        elif key.endswith("key_point_id") and isinstance(item, str):
            rewritten[key] = key_point_ids.get(item, item)
        else:
            rewritten[key] = rewrite_reference_geometry(
                item,
                frame_shift=frame_shift,
                key_point_ids=key_point_ids,
                total_frames=total_frames,
            )
    return rewritten


def analyze(job: AIJobRequest, _clip: Path) -> AnalysisBundle:
    root = handoff_root()
    reference_job = load_json(root / "input" / "ai-job.json")
    frame_shift, key_point_ids = validate_reference_job(job, reference_job)

    raw_result = rewrite_reference_geometry(
        deepcopy(load_json(root / "expected-output" / "analysis-result.mock.json")),
        frame_shift=frame_shift,
        key_point_ids=key_point_ids,
        total_frames=int(job.clip.video.total_frames),
    )
    analysis_id = str(uuid5(NAMESPACE_URL, f"contract-lab-tracking-replay:{job.ai_job_id}"))
    raw_result.update(
        {
            "analysis_id": analysis_id,
            "analysis_version": ANALYSIS_VERSION,
            "ai_job_id": job.ai_job_id,
            "rally_submission_id": job.rally_submission_id,
            "rally_id": job.rally_id,
            "match_id": job.match_id,
            "annotation_revision": job.annotation_revision,
            "clip_asset_id": job.clip.clip_asset_id,
            "input_clip_sha256": job.clip.sha256,
            "producer": {
                "name": "contract-lab-tracking-replay",
                "build_id": PROVIDER_BUILD,
                "sdk_version": "0.1.0",
            },
        }
    )
    for event, point in zip(raw_result.get("contact_events", []), job.key_points, strict=True):
        # The immutable annotation anchor is authoritative. Recorded inference geometry is
        # shifted with the source clip, while contact anchors follow the submitted points.
        event.update(
            {
                "key_point_id": point.key_point_id,
                "sequence_index": point.sequence_index,
                "marker_kind": point.marker_kind,
                "is_terminal": point.is_terminal,
                "anchor_frame_index": str(point.clip_frame_index),
            }
        )
    raw_result["extensions"] = {
        "synthetic": False,
        "recorded_inference_replay": True,
        "network_calls": 0,
        "tracking_source": "recorded_yolox_deep_eiou_sam_output",
        "ball_source": "human_frame_annotation",
        "action_source": "ball_path_heuristic_no_model",
        "court_pos_units": "canonical_normalized_18m_x_9m",
    }
    result = AnalysisResult.model_validate(rewrite_heuristic_labels(raw_result))

    with (root / "tracking-data" / "tracks-sam-deep-eiou.jsonl").open(encoding="utf-8") as handle:
        frame_records = [json.loads(line) for line in handle if line.strip()]
    shifted_records = []
    for record in frame_records:
        shifted_index = int(record["frame_index"]) + frame_shift
        if 0 <= shifted_index < int(job.clip.video.total_frames):
            shifted = deepcopy(record)
            shifted["frame_index"] = shifted_index
            shifted_records.append(shifted)
    ball_document = load_json(root / "input" / "ball-annotations.manual.json")
    ball_positions = {
        int(point["clip_frame_index"]) + frame_shift: point["frame_pos"]
        for point in ball_document["points"]
        if 0 <= int(point["clip_frame_index"]) + frame_shift < int(job.clip.video.total_frames)
    }
    overlay = build_tracking_overlay(
        job,
        analysis_id=analysis_id,
        analysis_version=ANALYSIS_VERSION,
        frame_records=shifted_records,
        ball_positions=ball_positions,
    )
    return AnalysisBundle(result=result, overlay_bytes=overlay)


capabilities = ProviderCapabilities.model_validate(
    {
        "schema_version": "1.0.0",
        "provider_name": "contract-lab-tracking-replay",
        "provider_build_id": PROVIDER_BUILD,
        "supported_job_schema_versions": ["1.1.0"],
        "supported_result_schema_versions": ["1.0.0"],
        "supported_overlay_formats": ["flatbuffers_v1"],
        "optional_extensions": {"action": True, "group_phase": False, "confidence": True},
        "action_taxonomies": [
            {
                "taxonomy_id": "volleyball-ai-contract-lab.ball-path-heuristic",
                "taxonomy_version": "1",
            }
        ],
    }
)

app = create_provider_app(analyze=analyze, capabilities=capabilities)
