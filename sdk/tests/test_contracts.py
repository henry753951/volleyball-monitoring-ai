import json
from pathlib import Path

import pytest
from volleyball_monitoring_ai import (
    AIJobRequest,
    AnalysisDomainData,
    AnalysisEvidenceManifest,
    CanonicalFrameAnchor,
    FrameStepRequest,
    IdentityPreviewJobRequest,
    IdentityPreviewResult,
    MediaApiError,
    PersonPoseEvidenceManifest,
    PlaybackCursor,
    PlaybackWindowDescriptor,
    PlaybackWindowExtendRequest,
    PlaybackWindowRequest,
    PlayerCropSourceManifest,
    ProviderAnalysisJobRequest,
    ProviderCapabilities,
    ProviderWorkCapabilities,
    ProviderWorkEnvelope,
    ReidAssociationJobRequest,
    ReidAssociationResult,
    ReidBankSnapshot,
    ReidFeatureJobRequest,
    ReidFeatureResult,
    ReidJerseyVlmResponseBundle,
    ReidRosterSnapshot,
    ResolvedMediaAnchor,
    build_analysis_data,
    build_empty_analysis_data,
    parse_provider_work_client_message,
    parse_provider_work_server_message,
    validate_passthrough,
)
from volleyball_monitoring_ai.analysis_data import _domain_json

FIXTURES = Path(__file__).parents[2] / "packages" / "contracts" / "fixtures"
AI_EXAMPLES = FIXTURES.parent / "examples" / "ai"


@pytest.mark.parametrize(
    "name",
    ["normal-rally", "unknown-outcome", "ambiguous-actors", "missing-ball", "resolved-multiple"],
)
def test_golden_contracts(name: str) -> None:
    folder = FIXTURES / name
    job = AIJobRequest.model_validate_json((folder / "job.json").read_text())
    result = AnalysisDomainData.model_validate_json(
        (folder / "analysis-data-domain.json").read_text()
    )
    validate_passthrough(job, result)


def test_court_position_is_not_clamped() -> None:
    result = json.loads((FIXTURES / "normal-rally" / "analysis-data-domain.json").read_text())
    assert result["contact_events"][0]["representative_court_positions"][0]["court_pos"]["x"] < 0
    assert result["contact_events"][-1]["representative_court_positions"][0]["court_pos"]["x"] > 1


def test_resolved_multiple_preserves_two_actors_without_candidates() -> None:
    result = AnalysisDomainData.model_validate_json(
        (FIXTURES / "resolved-multiple" / "analysis-data-domain.json").read_text()
    )
    event = next(
        event for event in result.contact_events if event.association_state == "resolved_multiple"
    )
    assert len(event.actors) >= 2
    assert event.actor_candidates == []
    assert all(
        actor.action is None and actor.association_confidence is None for actor in event.actors
    )
    assert any(actor.court_pos and actor.court_pos.x > 1 for actor in event.actors)


def test_unknown_outcome_is_explicit_and_valid() -> None:
    job = AIJobRequest.model_validate_json((FIXTURES / "unknown-outcome" / "job.json").read_text())
    assert job.outcome.score_resolution == "unknown"
    assert job.outcome.scoring_court_side is None


def test_contract_versions_are_explicit() -> None:
    job = AIJobRequest.model_validate_json((FIXTURES / "normal-rally" / "job.json").read_text())
    assert job.schema_version == "3.0.0"
    capabilities_path = FIXTURES.parents[0] / "examples" / "ai" / "capabilities.json"
    capabilities = ProviderCapabilities.model_validate_json(capabilities_path.read_text())
    assert capabilities.supported_job_schema_versions == ["3.0.0"]


def test_provider_work_contracts_are_capability_gated_and_reproducible() -> None:
    capabilities = ProviderWorkCapabilities.model_validate_json(
        (AI_EXAMPLES / "provider-capabilities-v3.json").read_text()
    )
    envelope = ProviderWorkEnvelope.model_validate_json(
        (AI_EXAMPLES / "provider-work-envelope.json").read_text()
    )
    hello = parse_provider_work_client_message(
        json.loads((AI_EXAMPLES / "provider-work-hello.json").read_text())
    )
    offer = parse_provider_work_server_message(
        json.loads((AI_EXAMPLES / "provider-work-job-offer.json").read_text())
    )
    analysis_job = ProviderAnalysisJobRequest.model_validate_json(
        (AI_EXAMPLES / "provider-analysis-job.json").read_text()
    )
    assert capabilities.work_capabilities[0].work_kind == "ANALYSIS"
    assert envelope.work_kind == "REID_FEATURE_EXTRACTION"
    assert hello.type == "provider_hello"
    assert offer.type == "job_offer"
    assert offer.work.provider_job_id == offer.provider_job_id
    assert analysis_job.modules.person_pose == "run"
    assert not hasattr(analysis_job.modules, "reid")


def test_pose_and_reid_artifact_models_validate_golden_examples() -> None:
    pose = PersonPoseEvidenceManifest.model_validate_json(
        (AI_EXAMPLES / "person-pose-evidence-manifest.json").read_text()
    )
    analysis = AnalysisEvidenceManifest.model_validate_json(
        (AI_EXAMPLES / "analysis-evidence-manifest.json").read_text()
    )
    crop_source = PlayerCropSourceManifest.model_validate_json(
        (AI_EXAMPLES / "player-crop-source-manifest.json").read_text()
    )
    feature_job = ReidFeatureJobRequest.model_validate_json(
        (AI_EXAMPLES / "reid-feature-job.json").read_text()
    )
    roster = ReidRosterSnapshot.model_validate_json(
        (AI_EXAMPLES / "reid-roster-snapshot.json").read_text()
    )
    feature_result = ReidFeatureResult.model_validate_json(
        (AI_EXAMPLES / "reid-feature-result.json").read_text()
    )
    jersey_responses = ReidJerseyVlmResponseBundle.model_validate_json(
        (AI_EXAMPLES / "reid-jersey-vlm-response.json").read_text()
    )
    bank = ReidBankSnapshot.model_validate_json(
        (AI_EXAMPLES / "reid-bank-snapshot.json").read_text()
    )
    association_job = ReidAssociationJobRequest.model_validate_json(
        (AI_EXAMPLES / "reid-association-job.json").read_text()
    )
    association_result = ReidAssociationResult.model_validate_json(
        (AI_EXAMPLES / "reid-association-result.json").read_text()
    )
    preview_job = IdentityPreviewJobRequest.model_validate_json(
        (AI_EXAMPLES / "identity-preview-job.json").read_text()
    )
    preview_result = IdentityPreviewResult.model_validate_json(
        (AI_EXAMPLES / "identity-preview-result.json").read_text()
    )
    assert int(pose.pose_observation_count) + int(pose.missing_observation_count) == int(
        pose.player_observation_count
    )
    assert analysis.pose_manifest_artifact.kind == "PERSON_POSE_EVIDENCE_MANIFEST"
    assert crop_source.coordinate_space == "NORMALIZED_VIDEO"
    assert feature_job.pose_recipe_namespace == "pose/yolo-coco17/every-frame-v1"
    assert roster.match_id == feature_job.match_id
    assert feature_result.tracklets[0].vectors[0].dimension == 384
    assert jersey_responses.evidence_set_id == feature_result.evidence_set_id
    assert bank.memberships[0].evidence_state == "CONFIRMED"
    assert association_job.recipe.allow_abstention is True
    assert association_result.decisions[0].association_state == "NEEDS_REVIEW"
    assert preview_job.selected_frame_indices == ["120", "132", "144", "156"]
    assert preview_result.frame_count == len(preview_result.source_frame_indices)


def test_identity_preview_rejects_reordered_or_mismatched_frames() -> None:
    request = json.loads((AI_EXAMPLES / "identity-preview-job.json").read_text())
    request["selected_frame_indices"] = ["132", "120"]
    with pytest.raises(ValueError, match="strictly increasing"):
        IdentityPreviewJobRequest.model_validate(request)

    result = json.loads((AI_EXAMPLES / "identity-preview-result.json").read_text())
    result["frame_count"] = 3
    with pytest.raises(ValueError, match="frame_count"):
        IdentityPreviewResult.model_validate(result)


def test_pose_manifest_rejects_partial_frame_coverage() -> None:
    payload = json.loads((AI_EXAMPLES / "person-pose-evidence-manifest.json").read_text())
    payload["canonical_frame_count"] = "121"
    with pytest.raises(ValueError, match="every canonical frame"):
        PersonPoseEvidenceManifest.model_validate(payload)


def test_boundary_job_allows_zero_manual_contacts_and_pending_score() -> None:
    job = AIJobRequest.model_validate_json(
        (FIXTURES.parents[0] / "examples" / "ai" / "boundary-job.json").read_text()
    )
    assert job.schema_version == "3.0.0"
    assert job.key_points == []
    assert [boundary.kind for boundary in job.boundaries or []] == ["start", "end"]
    assert job.outcome.score_resolution == "pending"


def test_boundary_job_rejects_terminal_or_service_contact_hints() -> None:
    payload = json.loads(
        (FIXTURES.parents[0] / "examples" / "ai" / "boundary-job.json").read_text()
    )
    payload["key_points"] = [
        {
            "key_point_id": "bad-service",
            "sequence_index": 0,
            "marker_kind": "service",
            "is_terminal": True,
            "clip_pts": "300300",
            "clip_time_us": "5005000",
            "clip_frame_index": "300",
        }
    ]
    with pytest.raises(ValueError):
        AIJobRequest.model_validate(payload)


def test_empty_analysis_data_uses_real_vad1_table() -> None:
    job = AIJobRequest.model_validate_json((FIXTURES / "normal-rally" / "job.json").read_text())
    domain = AnalysisDomainData.model_validate_json(
        (FIXTURES / "normal-rally" / "analysis-data-domain.json").read_text()
    )
    analysis_data = build_empty_analysis_data(job, domain=domain)
    assert analysis_data[4:8] == b"VAD1"
    assert len(analysis_data) > int(job.clip.video.total_frames) * 6


def test_analysis_data_domain_wire_json_omits_optional_nulls_but_keeps_ai_provenance() -> None:
    domain = AnalysisDomainData.model_validate_json(
        (FIXTURES / "normal-rally" / "analysis-data-domain.json").read_text()
    )
    payload = json.loads(_domain_json(domain))
    ai_event = next(
        event for event in payload["contact_events"] if event["source_key_point_id"] is None
    )

    assert "detection_confidence" not in ai_event or isinstance(
        ai_event["detection_confidence"], float
    )
    assert ai_event["source_key_point_id"] is None
    assert all(actor.get("court_pos", {}) is not None for actor in ai_event["actors"])
    assert all(actor.get("action", {}) is not None for actor in ai_event["actors"])


def test_analysis_data_preserves_unclamped_court_positions() -> None:
    job = AIJobRequest.model_validate_json((FIXTURES / "normal-rally" / "job.json").read_text())
    domain = AnalysisDomainData.model_validate_json(
        (FIXTURES / "normal-rally" / "analysis-data-domain.json").read_text()
    )
    analysis_data = build_analysis_data(
        job,
        domain=domain,
        frame_records=[
            {
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
            }
        ],
        ball_positions={0: {"x": 0.5, "y": 0.5, "confidence": 0.95}},
        court_keypoints={
            0: [
                {"keypoint_id": 0, "frame_pos": {"x": 0.05, "y": 0.9}, "confidence": 0.98},
                {"keypoint_id": 35, "frame_pos": {"x": 0.95, "y": 0.1}, "confidence": 0.87},
            ]
        },
        action_taxonomy_id="volleyball-analysis-engine.rtv4-x3d-actions",
        action_taxonomy_version="1",
    )
    assert analysis_data[4:8] == b"VAD1"


def test_non_monotonic_key_points_are_rejected() -> None:
    payload = json.loads((FIXTURES / "normal-rally" / "job.json").read_text())
    payload["key_points"][1]["clip_frame_index"] = "1"
    with pytest.raises(ValueError):
        AIJobRequest.model_validate(payload)


def test_media_fixtures_validate_and_preserve_decimal_strings() -> None:
    media = Path(__file__).parents[2] / "packages" / "contracts" / "examples" / "media"
    PlaybackWindowRequest.model_validate_json((media / "playback-window-request.json").read_text())
    PlaybackWindowExtendRequest.model_validate_json(
        (media / "playback-window-extend-request.json").read_text()
    )
    PlaybackWindowDescriptor.model_validate_json(
        (media / "playback-window-descriptor-live.json").read_text()
    )
    cursor = PlaybackCursor.model_validate_json(
        (media / "playback-cursor-fallback.json").read_text()
    )
    assert cursor.player_media_time_us == "9007199254740993"
    ResolvedMediaAnchor.model_validate_json(
        (media / "resolved-media-anchor-negative-pts.json").read_text()
    )
    frame_step = FrameStepRequest.model_validate_json(
        (media / "frame-step-request.json").read_text()
    )
    assert frame_step.count == 5
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
