from __future__ import annotations

import struct
from uuid import NAMESPACE_URL, uuid5

from volleyball_monitoring_ai import AnalysisBundle, AIJobRequest, AnalysisResult, create_provider_app


def analyze(job: AIJobRequest, _clip) -> AnalysisBundle:
    events = []
    for point in job.key_points:
        terminal = point.is_terminal
        events.append(
            {
                "key_point_id": point.key_point_id,
                "sequence_index": point.sequence_index,
                "marker_kind": point.marker_kind,
                "is_terminal": terminal,
                "anchor_frame_index": point.clip_frame_index,
                "resolved_frame_index": point.clip_frame_index,
                "association_state": "no_player" if terminal else "unresolved",
                "actors": [],
                "actor_candidates": [],
                "ball": {"state": "missing"},
                "representative_court_positions": [],
                "quality_flags": ["fake_provider_no_model"],
            }
        )
    paths = [
        {
            "sequence_index": index,
            "start_key_point_id": events[index]["key_point_id"],
            "end_key_point_id": events[index + 1]["key_point_id"],
            "start_frame_index": events[index]["resolved_frame_index"],
            "end_frame_index": events[index + 1]["resolved_frame_index"],
            "start_court_positions": [],
            "end_court_positions": [],
            "render_state": "unavailable",
            "is_terminal_segment": events[index + 1]["is_terminal"],
            "quality_flags": ["fake_provider_no_model"],
        }
        for index in range(max(len(events) - 1, 0))
    ]
    analysis_id = str(uuid5(NAMESPACE_URL, f"volleyball-fake-analysis:{job.ai_job_id}"))
    result = AnalysisResult.model_validate(
        {
            "schema_version": "1.0.0",
            "analysis_id": analysis_id,
            "analysis_version": "fake-provider-v1",
            "ai_job_id": job.ai_job_id,
            "rally_submission_id": job.rally_submission_id,
            "rally_id": job.rally_id,
            "match_id": job.match_id,
            "annotation_revision": job.annotation_revision,
            "clip_asset_id": job.clip.clip_asset_id,
            "input_clip_sha256": job.clip.sha256,
            "producer": {"name": "development-fake-ai", "build_id": "fixture-v1", "sdk_version": "0.1.0"},
            "tracks": [],
            "contact_events": events,
            "path_segments": paths,
            "summary": {
                "track_count": 0,
                "contact_event_count": len(events),
                "path_segment_count": len(paths),
                "unresolved_event_count": sum(event["association_state"] == "unresolved" for event in events),
                "multiple_event_count": 0,
                "warnings": ["Development fake provider returns no AI-generated positions."],
            },
            "extensions": {},
        }
    )
    overlay = struct.pack("<I4sHHI", 12, b"VOV1", 4, 4, 4)
    return AnalysisBundle(result=result, overlay_bytes=overlay)


app = create_provider_app(analyze=analyze)
