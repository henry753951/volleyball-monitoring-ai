import hashlib
import json
from pathlib import Path

import pytest
from volleyball_monitoring_ai import FixtureResultBuilder, OfflineRunner

ROOT = Path(__file__).parents[2]
FIXTURE = ROOT / "packages" / "contracts" / "fixtures" / "normal-rally" / "job.json"


@pytest.mark.asyncio
async def test_offline_runner_writes_bundle_without_network(tmp_path: Path) -> None:
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"offline canonical clip")
    payload = json.loads(FIXTURE.read_text(encoding="utf-8"))
    payload["clip"]["byte_length"] = str(clip.stat().st_size)
    payload["clip"]["sha256"] = hashlib.sha256(clip.read_bytes()).hexdigest()
    job_path = tmp_path / "ai-job.json"
    job_path.write_text(json.dumps(payload), encoding="utf-8")
    stages: list[str] = []

    result = await OfflineRunner().run(
        job_path=job_path,
        clip_path=clip,
        output_dir=tmp_path / "output",
        analyzer=lambda job, _clip, report: (
            report(0.5, "analyzing") or FixtureResultBuilder().build(job)
        ),
        progress=lambda _progress, stage: stages.append(stage),
    )

    assert result.analysis_data_path.exists()
    assert result.analysis_data_path.read_bytes()[4:8] == b"VAD1"
    manifest = json.loads(result.manifest_path.read_text(encoding="utf-8"))
    assert manifest["network_used"] is False
    assert stages == ["offline_inputs_ready", "analyzing", "offline_artifacts_written"]


def test_offline_runner_accepts_standalone_key_point_file(tmp_path: Path) -> None:
    payload = json.loads(FIXTURE.read_text(encoding="utf-8"))
    job_path = tmp_path / "ai-job.json"
    job_path.write_text(json.dumps(payload), encoding="utf-8")
    key_points_path = tmp_path / "keypoints.json"
    key_points_path.write_text(json.dumps({"key_points": payload["key_points"]}), encoding="utf-8")

    job = OfflineRunner.load_job(job_path, key_points_path)

    assert [point.key_point_id for point in job.key_points] == [
        point["key_point_id"] for point in payload["key_points"]
    ]
