from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
from uuid import uuid4

import httpx

from .analysis_data import validate_analysis_data_bytes
from .models import AIJobRequest


class CallbackClient:
    def __init__(
        self,
        job: AIJobRequest,
        *,
        timeout_seconds: float = 60.0,
        retry_delays_seconds: tuple[float, ...] = (0.5, 1.0, 2.0, 4.0),
    ):
        self.job = job
        self.timeout = timeout_seconds
        self.retry_delays = retry_delays_seconds

    def _headers(self, callback_id: str) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.job.callback.token}",
            "Idempotency-Key": callback_id,
        }

    async def _post(self, callback_id: str, **kwargs) -> httpx.Response:
        """Commit one idempotent callback, retrying only transient transport failures."""
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            for attempt in range(len(self.retry_delays) + 1):
                try:
                    response = await client.post(
                        str(self.job.callback.url),
                        headers=self._headers(callback_id),
                        **kwargs,
                    )
                    if response.status_code not in {408, 425, 429} and response.status_code < 500:
                        if response.is_error:
                            detail = response.text.strip()[:1_000]
                            raise httpx.HTTPStatusError(
                                f"Callback rejected with {response.status_code}: {detail}",
                                request=response.request,
                                response=response,
                            )
                        return response
                    response.raise_for_status()
                    return response
                except (httpx.TransportError, httpx.HTTPStatusError) as error:
                    retryable_status = (
                        isinstance(error, httpx.HTTPStatusError)
                        and error.response.status_code in {408, 425, 429}
                    ) or (
                        isinstance(error, httpx.HTTPStatusError)
                        and error.response.status_code >= 500
                    )
                    if attempt >= len(self.retry_delays) or (
                        isinstance(error, httpx.HTTPStatusError) and not retryable_status
                    ):
                        raise
                    await asyncio.sleep(self.retry_delays[attempt])
        raise RuntimeError("callback retry loop exited unexpectedly")

    async def processing(
        self, *, progress: float | None = None, stage: str | None = None, message: str | None = None
    ) -> httpx.Response:
        callback_id = str(uuid4())
        payload = {
            "schema_version": "2.0.0",
            "callback_id": callback_id,
            "ai_job_id": self.job.ai_job_id,
            "kind": "processing",
            "progress": progress,
            "stage": stage,
            "message": message,
        }
        return await self._post(
            callback_id,
            json={k: v for k, v in payload.items() if v is not None},
        )

    async def failed(
        self, *, code: str, message: str, retryable: bool, details: dict | None = None
    ) -> httpx.Response:
        callback_id = str(uuid4())
        payload = {
            "schema_version": "2.0.0",
            "callback_id": callback_id,
            "ai_job_id": self.job.ai_job_id,
            "kind": "failed",
            "error": {"code": code, "message": message, "retryable": retryable, "details": details},
        }
        if details is None:
            payload["error"].pop("details")
        return await self._post(callback_id, json=payload)

    async def completed(self, analysis_data: bytes | Path) -> httpx.Response:
        analysis_data_bytes = (
            analysis_data.read_bytes() if isinstance(analysis_data, Path) else analysis_data
        )
        validate_analysis_data_bytes(analysis_data_bytes)
        callback_id = str(uuid4())
        metadata = {
            "schema_version": "2.0.0",
            "callback_id": callback_id,
            "ai_job_id": self.job.ai_job_id,
            "kind": "completed",
            "analysis_data_sha256": hashlib.sha256(analysis_data_bytes).hexdigest(),
            "analysis_data_bytes": str(len(analysis_data_bytes)),
        }
        files = {
            "metadata": (None, json.dumps(metadata), "application/json"),
            "analysis_data": (
                "analysis-data.fb",
                analysis_data_bytes,
                "application/vnd.volleyball.analysis-data+flatbuffers;version=1",
            ),
        }
        return await self._post(callback_id, files=files)
