from __future__ import annotations

import copy
from importlib.resources import files
from itertools import pairwise
from pathlib import Path
from uuid import uuid4

from .analysis_data import build_empty_analysis_data
from .models import AIJobRequest, AnalysisDataBundle, AnalysisDomainData
from .validation import validate_passthrough


class FixtureResultBuilder:
    """Adapts the bundled golden result into a valid result for an incoming job.

    This is example infrastructure, not an AI model. Replace ``build`` with the
    provider's actual tracking and analysis pipeline in production.
    """

    def __init__(self, *, analysis_version: str = "fixture-example-v1") -> None:
        self.analysis_version = analysis_version
        fixture = files("volleyball_monitoring_ai").joinpath(
            "fixtures/normal-rally-analysis-data-domain.json"
        )
        if not fixture.is_file():
            fixture = (
                Path(__file__).resolve().parents[3]
                / "packages/contracts/fixtures/normal-rally/analysis-data-domain.json"
            )
        self._template = AnalysisDomainData.model_validate_json(fixture.read_text(encoding="utf-8"))

    def build(self, job: AIJobRequest) -> AnalysisDataBundle:
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

        human_templates = [
            event
            for event in payload["contact_events"]
            if event.get("anchor_origin", "human_anchor") == "human_anchor"
        ]
        detected_templates = [
            event
            for event in payload["contact_events"]
            if event.get("anchor_origin") == "ai_detected"
        ]
        events: list[dict] = []
        for index, point in enumerate(job.key_points):
            event = copy.deepcopy(human_templates[min(index, len(human_templates) - 1)])
            event.update(
                {
                    "key_point_id": point.key_point_id,
                    "source_key_point_id": point.key_point_id,
                    "anchor_origin": "human_anchor",
                    "detection_confidence": None,
                    "sequence_index": index,
                    "marker_kind": point.marker_kind,
                    "is_terminal": point.is_terminal,
                    "anchor_frame_index": point.clip_frame_index,
                }
            )
            events.append(event)

        # The bundled fixture predates AI-origin anchors. For a boundary-only job
        # request, reinterpret its contact templates as detector output so the
        # example provider demonstrates the intended zero-manual-contact flow.
        if not detected_templates and not job.key_points:
            detected_templates = human_templates
        if job.schema_version == "3.0.0":
            for index, template in enumerate(detected_templates):
                event = copy.deepcopy(template)
                event.update(
                    {
                        "key_point_id": f"ai-detected-{index}",
                        "source_key_point_id": None,
                        "anchor_origin": "ai_detected",
                        "detection_confidence": event.get("detection_confidence") or 0.75,
                        "marker_kind": "contact",
                        "is_terminal": False,
                    }
                )
                events.append(event)

        events.sort(key=lambda event: int(event["anchor_frame_index"]))
        for index, event in enumerate(events):
            event["sequence_index"] = index
        payload["contact_events"] = events

        segment_templates = payload["path_segments"]
        segments: list[dict] = []
        for index, (start, end) in enumerate(pairwise(events)):
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

        domain = AnalysisDomainData.model_validate(payload)
        validate_passthrough(job, domain)
        analysis_data = build_empty_analysis_data(job, domain=domain)
        return AnalysisDataBundle(domain=domain, analysis_data_bytes=analysis_data)
