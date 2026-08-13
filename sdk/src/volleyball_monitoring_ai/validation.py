from .models import AIJobRequest, AnalysisDomainData


def validate_passthrough(job: AIJobRequest, result: AnalysisDomainData) -> None:
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

    human_events = [event for event in result.contact_events if event.anchor_origin == "human_anchor"]
    if [event.source_key_point_id for event in human_events] != [
        point.key_point_id for point in job.key_points
    ]:
        raise ValueError("human contact events must preserve every input key point in order")
    if any(
        event.source_key_point_id is not None
        or event.marker_kind != "contact"
        or event.is_terminal
        for event in result.contact_events
        if event.anchor_origin == "ai_detected"
    ):
        raise ValueError("AI-detected events cannot claim immutable input key points")
    pairs_to_validate = zip(job.key_points, human_events, strict=True)

    for point, event in pairs_to_validate:
        if (point.marker_kind, point.is_terminal, point.clip_frame_index) != (
            event.marker_kind, event.is_terminal, event.anchor_frame_index
        ):
            raise ValueError(f"key point passthrough mismatch: {point.key_point_id}")
