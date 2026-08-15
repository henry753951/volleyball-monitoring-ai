import pytest
from volleyball_monitoring_ai import (
    PersonPoseRecord,
    build_person_pose_evidence_chunk,
    decode_person_pose_evidence_chunk,
)


def available(track_id: int) -> PersonPoseRecord:
    return PersonPoseRecord(
        track_id=track_id,
        bbox_source="DETECTOR",
        frame_bbox=(0.1, 0.2, 0.3, 0.8),
        crop_transform=(1 / 1920, 1 / 1080, 0.1, 0.2),
        status="AVAILABLE",
        keypoints=tuple((0.2 + index / 100, 0.3 + index / 100, 0.9) for index in range(17)),
    )


def missing(track_id: int) -> PersonPoseRecord:
    return PersonPoseRecord(
        track_id=track_id,
        bbox_source="TRACKER_PROPAGATED",
        frame_bbox=(0.4, 0.2, 0.6, 0.9),
        crop_transform=(1 / 1920, 1 / 1080, 0.4, 0.2),
        status="INFERENCE_FAILED",
        keypoints=None,
    )


def test_pose_chunk_round_trips_every_frame_and_explicit_missing_observation() -> None:
    data = build_person_pose_evidence_chunk(
        analysis_run_id="analysis-001",
        pose_recipe_namespace="yolo-coco17@sha256:fixture",
        start_frame_index=30,
        frames=[[available(8), available(2)], [missing(2)], []],
    )
    decoded = decode_person_pose_evidence_chunk(data)
    assert decoded.analysis_run_id == "analysis-001"
    assert decoded.start_frame_index == 30
    assert [record.track_id for record in decoded.frames[0]] == [2, 8]
    assert decoded.frames[1][0].status == "INFERENCE_FAILED"
    assert decoded.frames[1][0].keypoints is None
    assert decoded.frames[2] == ()
    assert len(decoded.observation_sha256) == 3


def test_pose_chunk_rejects_duplicate_track_in_one_frame() -> None:
    with pytest.raises(ValueError, match="duplicate track IDs"):
        build_person_pose_evidence_chunk(
            analysis_run_id="analysis-001",
            pose_recipe_namespace="pose-v1",
            start_frame_index=0,
            frames=[[available(2), available(2)]],
        )


def test_pose_chunk_never_uses_zero_coordinates_for_missing_keypoints() -> None:
    invalid = PersonPoseRecord(
        track_id=1,
        bbox_source="DETECTOR",
        frame_bbox=(0.1, 0.2, 0.3, 0.8),
        crop_transform=(1 / 1920, 1 / 1080, 0.1, 0.2),
        status="LOW_QUALITY",
        keypoints=tuple([(0.0, 0.0, -1.0)] * 17),
    )
    with pytest.raises(ValueError, match="never fabricated"):
        build_person_pose_evidence_chunk(
            analysis_run_id="analysis-001",
            pose_recipe_namespace="pose-v1",
            start_frame_index=0,
            frames=[[invalid]],
        )
