from __future__ import annotations

import copy
from importlib.resources import files
from pathlib import Path
from uuid import uuid4

from .models import AIJobRequest, AnalysisBundle, AnalysisResult
from .overlay import build_empty_overlay
from .validation import validate_passthrough


class FixtureResultBuilder:
    """Adapts the bundled golden result into a valid result for an incoming job.

    This is example infrastructure, not an AI model. Replace ``build`` with the
    provider's actual tracking and analysis pipeline in production.
    """

    def __init__(self, *, analysis_version: str = "fixture-example-v1") -> None:
        self.analysis_version = analysis_version
        fixture = files("volleyball_monitoring_ai").joinpath(
            "fixtures/normal-rally-result.json"
        )
        if not fixture.is_file():
            fixture = Path(__file__).resolve().parents[3] / "packages/contracts/fixtures/normal-rally/result.json"
        self._template = AnalysisResult.model_validate_json(fixture.read_text(encoding="utf-8"))

    def build(self, job: AIJobRequest) -> AnalysisBundle:
        payload = self._template.model_dump(mode="json")
        payload.update(
            {
                "analysis_id": str(uuid4()),
                "analysis_version": self.analysis_version,
                "ai_job_id": job.ai_job_id,
                "rally_submission_id": job.rally_submission_id,
                "rally_id": job.rally_id,
                "match_id": job.match_id,
                "annotation_revision": job.annotation_revision,
                "clip_asset_id": job.clip.clip_asset_id,
                "input_clip_sha256": job.clip.sha256,
            }
        )

        templates = payload["contact_events"]
        events: list[dict] = []
        for index, point in enumerate(job.key_points):
            event = copy.deepcopy(templates[min(index, len(templates) - 1)])
            event.update(
                {
                    "key_point_id": point.key_point_id,
                    "sequence_index": index,
                    "marker_kind": point.marker_kind,
                    "is_terminal": point.is_terminal,
                    "anchor_frame_index": point.clip_frame_index,
                }
            )
            events.append(event)
        payload["contact_events"] = events

        segment_templates = payload["path_segments"]
        segments: list[dict] = []
        for index, (start, end) in enumerate(zip(events, events[1:], strict=False)):
            template_index = min(index, max(len(segment_templates) - 1, 0))
            segment = copy.deepcopy(segment_templates[template_index]) if segment_templates else {}
            segment.update(
                {
                    "sequence_index": index,
                    "start_key_point_id": start["key_point_id"],
                    "end_key_point_id": end["key_point_id"],
                    "start_court_positions": start["representative_court_positions"],
                    "end_court_positions": end["representative_court_positions"],
                    "is_terminal_segment": end["is_terminal"],
                }
            )
            segments.append(segment)
        payload["path_segments"] = segments

        payload["summary"]["contact_event_count"] = len(events)
        payload["summary"]["path_segment_count"] = len(segments)
        payload["summary"]["unresolved_event_count"] = sum(
            event["association_state"] in {"ambiguous", "unresolved"} for event in events
        )
        if payload["summary"].get("multiple_event_count") is not None:
            payload["summary"]["multiple_event_count"] = sum(
                event["association_state"] == "resolved_multiple" for event in events
            )

        result = AnalysisResult.model_validate(payload)
        validate_passthrough(job, result)
        overlay = build_empty_overlay(
            job,
            analysis_id=result.analysis_id,
            analysis_version=result.analysis_version,
        )
        return AnalysisBundle(result=result, overlay_bytes=overlay)
