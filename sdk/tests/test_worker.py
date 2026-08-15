import asyncio
import hashlib
import json
from pathlib import Path

import httpx
import pytest
import respx
from volleyball_monitoring_ai import (
    AIJobRequest,
    AIWorkerClient,
    CancellationToken,
    ClipDownloader,
    FixtureResultBuilder,
    JobAbortedError,
    ProviderCapabilities,
    WorkerConfig,
)
from websockets.asyncio.server import serve

ROOT = Path(__file__).parents[2]
FIXTURE = ROOT / "packages" / "contracts" / "fixtures" / "normal-rally" / "job.json"
BOUNDARY_FIXTURE = ROOT / "packages" / "contracts" / "examples" / "ai" / "boundary-job.json"
CAPABILITIES = ROOT / "packages" / "contracts" / "examples" / "ai" / "capabilities.json"


def job_with_clip(content: bytes) -> AIJobRequest:
    payload = json.loads(FIXTURE.read_text())
    payload["clip"]["download_url"] = "https://media.example.test/canonical.mp4"
    payload["clip"]["sha256"] = hashlib.sha256(content).hexdigest()
    payload["clip"]["byte_length"] = str(len(content))
    return AIJobRequest.model_validate(payload)


@pytest.mark.asyncio
@respx.mock
async def test_clip_downloader_uses_part_file_and_atomic_destination(tmp_path: Path) -> None:
    content = b"canonical-video-content"
    respx.get("https://media.example.test/canonical.mp4").mock(
        return_value=httpx.Response(200, content=content)
    )
    destination = tmp_path / "job" / "canonical.mp4"

    result = await ClipDownloader().download(
        job_with_clip(content), destination, CancellationToken()
    )

    assert result.read_bytes() == content
    assert not destination.with_suffix(".mp4.part").exists()


@pytest.mark.asyncio
@respx.mock
async def test_clip_downloader_cleans_partial_file_after_abort(tmp_path: Path) -> None:
    content = b"canonical-video-content"
    token = CancellationToken()
    token.abort("deleted by annotator")
    respx.get("https://media.example.test/canonical.mp4").mock(
        return_value=httpx.Response(200, content=content)
    )
    destination = tmp_path / "job" / "canonical.mp4"

    with pytest.raises(JobAbortedError):
        await ClipDownloader().download(job_with_clip(content), destination, token)

    assert not destination.exists()
    assert not destination.with_suffix(".mp4.part").exists()


@pytest.mark.asyncio
async def test_worker_accepts_job_and_obeys_abort(tmp_path: Path) -> None:
    job = AIJobRequest.model_validate_json(FIXTURE.read_text())
    capabilities = ProviderCapabilities.model_validate_json(CAPABILITIES.read_text())
    observed: list[dict] = []
    aborted = asyncio.Event()
    client_ref: AIWorkerClient | None = None

    async def ws_handler(websocket) -> None:
        hello = json.loads(await websocket.recv())
        observed.append(hello)
        assert hello["type"] == "provider_hello"
        assert hello["sdk_version"] == "0.4.0"
        await websocket.send(
            json.dumps(
                {
                    "schema_version": "1.0.0",
                    "type": "connection_ready",
                    "connection_id": "connection-test",
                    "server_time": "2026-08-08T00:00:00Z",
                    "heartbeat_interval_seconds": 30,
                    "lease_seconds": 60,
                }
            )
        )
        await websocket.send(
            json.dumps(
                {
                    "schema_version": "1.0.0",
                    "type": "job_offer",
                    "ai_job_id": job.ai_job_id,
                    "delivery_id": "delivery-test",
                    "lease_expires_at": "2026-08-08T00:01:00Z",
                    "job": job.model_dump(mode="json"),
                }
            )
        )
        accepted = json.loads(await websocket.recv())
        observed.append(accepted)
        assert accepted["type"] == "job_accepted"
        await websocket.send(
            json.dumps(
                {
                    "schema_version": "1.0.0",
                    "type": "abort_job",
                    "ai_job_id": job.ai_job_id,
                    "delivery_id": "delivery-test",
                    "reason": "processing clip deleted",
                }
            )
        )
        ack = json.loads(await websocket.recv())
        observed.append(ack)
        assert ack["type"] == "abort_ack"
        aborted.set()
        assert client_ref is not None
        await client_ref.stop()

    async def handler(context) -> None:
        await context.cancellation.wait()
        context.cancellation.raise_if_aborted()

    async with serve(ws_handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        client_ref = AIWorkerClient(
            WorkerConfig(
                server_ws_url=f"ws://127.0.0.1:{port}",
                token="test-token",
                workspace=tmp_path,
                provider_build_id="fixture-provider-v1",
                capabilities=capabilities,
                instance_id="test-instance",
            )
        )
        await asyncio.wait_for(client_ref.run_forever(handler), timeout=5)

    assert aborted.is_set()
    assert [message["type"] for message in observed] == [
        "provider_hello",
        "job_accepted",
        "abort_ack",
    ]


@pytest.mark.asyncio
async def test_worker_exits_when_authorization_is_revoked(tmp_path: Path) -> None:
    capabilities = ProviderCapabilities.model_validate_json(CAPABILITIES.read_text())
    connection_count = 0

    async def ws_handler(websocket) -> None:
        nonlocal connection_count
        connection_count += 1
        hello = json.loads(await websocket.recv())
        assert hello["type"] == "provider_hello"
        await websocket.send(
            json.dumps(
                {
                    "schema_version": "1.0.0",
                    "type": "protocol_error",
                    "code": "AUTHORIZATION_REVOKED",
                    "message": "worker token was deleted",
                    "retryable": False,
                }
            )
        )

    async def handler(_context) -> None:
        raise AssertionError("revoked worker must not receive work")

    async with serve(ws_handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        client = AIWorkerClient(
            WorkerConfig(
                server_ws_url=f"ws://127.0.0.1:{port}",
                token="revoked-token",
                workspace=tmp_path,
                provider_build_id="fixture-provider-v1",
                capabilities=capabilities,
                instance_id="revoked-instance",
            )
        )
        await asyncio.wait_for(client.run_forever(handler), timeout=2)

    assert connection_count == 1


def test_fixture_result_builder_adapts_golden_data_to_incoming_job() -> None:
    job = AIJobRequest.model_validate_json(FIXTURE.read_text())

    bundle = FixtureResultBuilder().build(job)

    assert bundle.domain.ai_job_id == job.ai_job_id
    assert [
        event.key_point_id
        for event in bundle.domain.contact_events
        if event.anchor_origin == "human_anchor"
    ] == [point.key_point_id for point in job.key_points]
    assert bundle.analysis_data_bytes[4:8] == b"VAD1"


def test_fixture_result_builder_emits_ai_contacts_for_boundary_only_job() -> None:
    job = AIJobRequest.model_validate_json(BOUNDARY_FIXTURE.read_text())
    bundle = FixtureResultBuilder().build(job)

    assert bundle.domain.contact_events
    assert all(event.anchor_origin == "ai_detected" for event in bundle.domain.contact_events)
    assert all(event.source_key_point_id is None for event in bundle.domain.contact_events)
