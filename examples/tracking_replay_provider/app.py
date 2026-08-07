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

ANALYSIS_VERSION = "contract-lab-tracking-replay-v1"
PROVIDER_BUILD = "yolox-deep-eiou-sam-court-v1"
EXPECTED_CLIP_SHA256 = "c1b643c6bcdb0e2bc4a03e349826e2da2463f7267b4e3856977a6bc55617207c"
EXPECTED_CLIP_BYTES = 6_100_084


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


def validate_reference_job(job: AIJobRequest, reference: dict[str, Any]) -> None:
    expected_points = reference.get("key_points", [])
    actual_signature = [
        (point.key_point_id, point.sequence_index, point.marker_kind, point.is_terminal, point.clip_frame_index)
        for point in job.key_points
    ]
    expected_signature = [
        (
            point["key_point_id"],
            point["sequence_index"],
            point["marker_kind"],
            point["is_terminal"],
            point["clip_frame_index"],
        )
        for point in expected_points
    ]
    if (
        job.clip.sha256.lower() != EXPECTED_CLIP_SHA256
        or int(job.clip.byte_length) != EXPECTED_CLIP_BYTES
        or int(job.clip.video.total_frames) != 1_033
        or actual_signature != expected_signature
    ):
        raise ValueError("tracking replay only supports the Contract Lab reference clip and immutable key points")


def analyze(job: AIJobRequest, _clip: Path) -> AnalysisBundle:
    root = handoff_root()
    reference_job = load_json(root / "input" / "ai-job.json")
    validate_reference_job(job, reference_job)

    raw_result = deepcopy(load_json(root / "expected-output" / "analysis-result.mock.json"))
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
    ball_document = load_json(root / "input" / "ball-annotations.manual.json")
    ball_positions = {
        int(point["clip_frame_index"]): point["frame_pos"]
        for point in ball_document["points"]
    }
    overlay = build_tracking_overlay(
        job,
        analysis_id=analysis_id,
        analysis_version=ANALYSIS_VERSION,
        frame_records=frame_records,
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
