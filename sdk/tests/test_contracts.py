import json
from pathlib import Path

import pytest

from volleyball_monitoring_ai import (
    AIJobRequest, AnalysisResult, ProviderCapabilities, validate_passthrough,
    PlaybackWindowRequest, PlaybackWindowExtendRequest, PlaybackWindowDescriptor, PlaybackCursor,
    ResolvedMediaAnchor, FrameStepRequest, CanonicalFrameAnchor, MediaApiError,
    build_empty_overlay, build_tracking_overlay,
)

FIXTURES = Path(__file__).parents[2] / "packages" / "contracts" / "fixtures"


@pytest.mark.parametrize("name", ["normal-rally", "unknown-outcome", "ambiguous-actors", "missing-ball", "resolved-multiple"])
def test_golden_contracts(name: str) -> None:
    folder = FIXTURES / name
    job = AIJobRequest.model_validate_json((folder / "job.json").read_text())
    result = AnalysisResult.model_validate_json((folder / "result.json").read_text())
    validate_passthrough(job, result)


def test_court_position_is_not_clamped() -> None:
    result = json.loads((FIXTURES / "normal-rally" / "result.json").read_text())
    assert result["contact_events"][0]["representative_court_positions"][0]["court_pos"]["x"] < 0
    assert result["contact_events"][-1]["representative_court_positions"][0]["court_pos"]["x"] > 1


def test_resolved_multiple_preserves_two_actors_without_candidates() -> None:
    result = AnalysisResult.model_validate_json((FIXTURES / "resolved-multiple" / "result.json").read_text())
    event = next(event for event in result.contact_events if event.association_state == "resolved_multiple")
    assert len(event.actors) >= 2
    assert event.actor_candidates == []
    assert all(actor.action is None and actor.association_confidence is None for actor in event.actors)
    assert any(actor.court_pos and actor.court_pos.x > 1 for actor in event.actors)


def test_unknown_outcome_is_explicit_and_valid() -> None:
    job = AIJobRequest.model_validate_json((FIXTURES / "unknown-outcome" / "job.json").read_text())
    assert job.outcome.score_resolution == "unknown"
    assert job.outcome.scoring_court_side is None


def test_contract_versions_are_explicit() -> None:
    job = AIJobRequest.model_validate_json((FIXTURES / "normal-rally" / "job.json").read_text())
    assert job.schema_version == "1.1.0"
    capabilities_path = FIXTURES.parents[0] / "examples" / "ai" / "capabilities.json"
    capabilities = ProviderCapabilities.model_validate_json(capabilities_path.read_text())
    assert "1.1.0" in capabilities.supported_job_schema_versions


def test_empty_provider_overlay_uses_real_vov1_table() -> None:
    job = AIJobRequest.model_validate_json((FIXTURES / "normal-rally" / "job.json").read_text())
    overlay = build_empty_overlay(job, analysis_id="fixture-analysis", analysis_version="fixture-v1")
    assert overlay[4:8] == b"VOV1"
    assert len(overlay) > int(job.clip.video.total_frames) * 6


def test_tracking_overlay_preserves_unclamped_court_positions() -> None:
    job = AIJobRequest.model_validate_json((FIXTURES / "normal-rally" / "job.json").read_text())
    overlay = build_tracking_overlay(
        job,
        analysis_id="tracking-analysis",
        analysis_version="tracking-replay-v1",
        frame_records=[{
            "frame_index": 0,
            "players": [
                {
                    "track_id": 7,
                    "frame_bbox": {"x1": 0.1, "y1": 0.2, "x2": 0.3, "y2": 0.4},
                    "frame_foot_pos": {"x": 0.2, "y": 0.4},
                    "court_pos": {"x": 1.25, "y": -0.15},
                    "confidence": 0.91,
                    "action_label": "setting",
                    "action_confidence": 0.84,
                },
                {
                    "track_id": 8,
                    "frame_bbox": {"x1": 0.5, "y1": 0.2, "x2": 0.7, "y2": 0.4},
                    "frame_foot_pos": {"x": 0.6, "y": 0.4},
                    "court_pos": None,
                },
            ],
        }],
        ball_positions={0: {"x": 0.5, "y": 0.5, "confidence": 0.95}},
        court_keypoints={0: [
            {"keypoint_id": 0, "frame_pos": {"x": 0.05, "y": 0.9}, "confidence": 0.98},
            {"keypoint_id": 35, "frame_pos": {"x": 0.95, "y": 0.1}, "confidence": 0.87},
        ]},
        action_taxonomy_id="volleyball-analysis-engine.rtv4-x3d-actions",
        action_taxonomy_version="1",
    )
    assert overlay[4:8] == b"VOV1"


def test_non_monotonic_key_points_are_rejected() -> None:
    payload = json.loads((FIXTURES / "normal-rally" / "job.json").read_text())
    payload["key_points"][1]["clip_frame_index"] = "1"
    with pytest.raises(ValueError):
        AIJobRequest.model_validate(payload)


def test_media_fixtures_validate_and_preserve_decimal_strings() -> None:
    media = Path(__file__).parents[2] / "packages" / "contracts" / "examples" / "media"
    PlaybackWindowRequest.model_validate_json((media / "playback-window-request.json").read_text())
    PlaybackWindowExtendRequest.model_validate_json((media / "playback-window-extend-request.json").read_text())
    PlaybackWindowDescriptor.model_validate_json((media / "playback-window-descriptor-live.json").read_text())
    cursor = PlaybackCursor.model_validate_json((media / "playback-cursor-fallback.json").read_text())
    assert cursor.player_media_time_us == "9007199254740993"
    ResolvedMediaAnchor.model_validate_json((media / "resolved-media-anchor-negative-pts.json").read_text())
    FrameStepRequest.model_validate_json((media / "frame-step-request.json").read_text())
    CanonicalFrameAnchor.model_validate_json((media / "canonical-frame-anchor.json").read_text())
    MediaApiError.model_validate_json((media / "error-classes.json").read_text())


def test_media_models_reject_numeric_wire_values_and_malformed_pts() -> None:
    media = Path(__file__).parents[2] / "packages" / "contracts" / "examples" / "media"
    payload = json.loads((media / "playback-cursor-fallback.json").read_text())
    payload["player_media_time_us"] = 9007199254740993
    with pytest.raises(ValueError):
        PlaybackCursor.model_validate(payload)
    anchor = json.loads((media / "resolved-media-anchor-negative-pts.json").read_text())
    anchor["source_pts"] = "not-decimal"
    with pytest.raises(ValueError):
        ResolvedMediaAnchor.model_validate(anchor)
