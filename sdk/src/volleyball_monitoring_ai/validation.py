from .models import AIJobRequest, AnalysisResult


def validate_passthrough(job: AIJobRequest, result: AnalysisResult) -> None:
    pairs = {
        "ai_job_id": (job.ai_job_id, result.ai_job_id),
        "rally_submission_id": (job.rally_submission_id, result.rally_submission_id),
        "rally_id": (job.rally_id, result.rally_id),
        "match_id": (job.match_id, result.match_id),
        "annotation_revision": (job.annotation_revision, result.annotation_revision),
        "clip_asset_id": (job.clip.clip_asset_id, result.clip_asset_id),
        "input_clip_sha256": (job.clip.sha256.lower(), result.input_clip_sha256.lower()),
    }
    mismatches = {name: values for name, values in pairs.items() if values[0] != values[1]}
    if mismatches:
        raise ValueError(f"PASSTHROUGH mismatch: {mismatches}")

    input_ids = [point.key_point_id for point in job.key_points]
    output_ids = [event.key_point_id for event in result.contact_events]
    if input_ids != output_ids:
        raise ValueError("contact_events must match input key_points one-to-one and in order")

    for point, event in zip(job.key_points, result.contact_events, strict=True):
        if (point.sequence_index, point.marker_kind, point.is_terminal, point.clip_frame_index) != (
            event.sequence_index, event.marker_kind, event.is_terminal, event.anchor_frame_index
        ):
            raise ValueError(f"key point passthrough mismatch: {point.key_point_id}")
