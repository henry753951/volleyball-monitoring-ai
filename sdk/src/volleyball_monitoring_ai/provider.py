import hashlib
import inspect
import tempfile
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from pathlib import Path

import httpx

from .callback import CallbackClient
from .models import AIJobRequest, AnalysisBundle, ProviderCapabilities
from .validation import validate_passthrough

AnalyzeFn = Callable[[AIJobRequest, Path], AnalysisBundle | Awaitable[AnalysisBundle]]


async def download_and_verify_clip(job: AIJobRequest, destination: Path) -> None:
    digest = hashlib.sha256()
    size = 0
    # clip.download_url is an independently signed, short-lived URL. Never leak the callback bearer token to object storage.
    async with (
        httpx.AsyncClient(timeout=None, follow_redirects=True) as client,
        client.stream("GET", str(job.clip.download_url)) as response,
    ):
        response.raise_for_status()
        with destination.open("wb") as handle:
            async for chunk in response.aiter_bytes():
                digest.update(chunk)
                size += len(chunk)
                handle.write(chunk)
    if digest.hexdigest().lower() != job.clip.sha256.lower() or size != int(job.clip.byte_length):
        destination.unlink(missing_ok=True)
        raise ValueError("clip checksum/length mismatch")


def create_provider_app(
    *,
    analyze: AnalyzeFn,
    capabilities: ProviderCapabilities | None = None,
):
    try:
        from fastapi import BackgroundTasks, FastAPI, Header, HTTPException
    except ImportError as exc:
        raise RuntimeError("Install the SDK with the provider extra") from exc

    app = FastAPI(title="Volleyball Monitoring External AI Provider")
    advertised = capabilities or ProviderCapabilities.model_validate(
        {
            "schema_version": "1.0.0",
            "provider_name": "example-provider",
            "provider_build_id": "replace-me",
            "supported_job_schema_versions": ["1.1.0"],
            "supported_result_schema_versions": ["1.0.0"],
            "supported_overlay_formats": ["flatbuffers_v1"],
            "optional_extensions": {
                "action": False,
                "group_phase": False,
                "confidence": False,
            },
            "action_taxonomies": [],
        }
    )

    @app.get("/v1/capabilities")
    async def capabilities() -> dict:
        return advertised.model_dump(mode="json")

    async def run_job(job: AIJobRequest) -> None:
        callback = CallbackClient(job)
        try:
            with tempfile.TemporaryDirectory(prefix="volleyball-ai-") as directory:
                clip = Path(directory) / "canonical.mp4"
                await download_and_verify_clip(job, clip)
                candidate = analyze(job, clip)
                bundle = await candidate if inspect.isawaitable(candidate) else candidate
                validate_passthrough(job, bundle.result)
                await callback.completed(bundle.result, bundle.overlay_bytes)
        except Exception as exc:  # noqa: BLE001 - provider boundary must close every job lifecycle
            # BackgroundTasks otherwise logs the exception after the 202 response while the
            # central job remains RUNNING forever. Providers must close the callback lifecycle.
            await callback.failed(
                code="PROVIDER_ANALYSIS_FAILED",
                message=str(exc)[:1000] or type(exc).__name__,
                retryable=not isinstance(exc, (ValueError, TypeError)),
                details={"exception_type": type(exc).__name__},
            )

    @app.post("/v1/jobs", status_code=202)
    async def submit(job: AIJobRequest, background_tasks: BackgroundTasks, idempotency_key: str | None = Header(default=None)) -> dict:
        if idempotency_key != job.ai_job_id:
            raise HTTPException(422, "Idempotency-Key must equal ai_job_id")
        # Adapter skeleton only. A production provider should persist an idempotency record and enqueue durably.
        background_tasks.add_task(run_job, job)
        return {
            "schema_version": "1.0.0",
            "ai_job_id": job.ai_job_id,
            "provider_job_id": job.ai_job_id,
            "state": "accepted",
            "accepted_at": datetime.now(UTC).isoformat(),
        }

    return app
