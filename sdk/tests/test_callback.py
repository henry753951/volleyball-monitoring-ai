import json
from pathlib import Path

import httpx
import pytest
import respx

from volleyball_monitoring_ai import AIJobRequest, AnalysisDomainData, build_empty_analysis_data
from volleyball_monitoring_ai.callback import CallbackClient


ROOT = Path(__file__).parents[2]
FIXTURE = ROOT / "packages" / "contracts" / "fixtures" / "normal-rally" / "job.json"
ANALYSIS_DATA_DOMAIN_FIXTURE = ROOT / "packages" / "contracts" / "fixtures" / "normal-rally" / "analysis-data-domain.json"


def callback_job() -> AIJobRequest:
    payload = json.loads(FIXTURE.read_text())
    payload["callback"]["url"] = "https://central.example.test/api/v1/ai/callback/job"
    return AIJobRequest.model_validate(payload)


@pytest.mark.asyncio
@respx.mock
async def test_processing_callback_retries_transient_failure_with_same_idempotency_key() -> None:
    route = respx.post("https://central.example.test/api/v1/ai/callback/job").mock(
        side_effect=[httpx.ConnectError("central restarting"), httpx.Response(200, json={"accepted": True})]
    )
    client = CallbackClient(callback_job(), retry_delays_seconds=(0.0,))

    response = await client.processing(progress=0.5, stage="tracking")

    assert response.status_code == 200
    assert route.call_count == 2
    assert route.calls[0].request.headers["Idempotency-Key"] == route.calls[1].request.headers["Idempotency-Key"]


@pytest.mark.asyncio
@respx.mock
async def test_callback_rejection_includes_central_error_body_without_retry() -> None:
    route = respx.post("https://central.example.test/api/v1/ai/callback/job").mock(
        return_value=httpx.Response(
            409,
            json={"code": "PASSTHROUGH_MISMATCH", "message": "contact event anchor frames must be strictly increasing"},
        )
    )
    client = CallbackClient(callback_job(), retry_delays_seconds=(0.0, 0.0))

    with pytest.raises(httpx.HTTPStatusError, match="anchor frames must be strictly increasing"):
        await client.processing(progress=0.5, stage="tracking")

    assert route.call_count == 1


@pytest.mark.asyncio
@respx.mock
async def test_completed_callback_preserves_explicit_null_ai_provenance() -> None:
    job = callback_job()
    domain = AnalysisDomainData.model_validate_json(ANALYSIS_DATA_DOMAIN_FIXTURE.read_text())
    analysis_data = build_empty_analysis_data(job, domain=domain)
    route = respx.post("https://central.example.test/api/v1/ai/callback/job").mock(
        return_value=httpx.Response(200, json={"accepted": True})
    )

    await CallbackClient(job, retry_delays_seconds=()).completed(analysis_data)

    assert route.call_count == 1
    assert b'"anchor_origin":"ai_detected"' in route.calls[0].request.content
    assert b'"source_key_point_id":null' in route.calls[0].request.content
