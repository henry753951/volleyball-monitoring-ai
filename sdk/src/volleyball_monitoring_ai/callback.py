from __future__ import annotations

import hashlib
import json
from pathlib import Path
from uuid import uuid4

import httpx

from .models import AIJobRequest, AnalysisResult
from .overlay import validate_overlay_bytes
from .validation import validate_passthrough


class CallbackClient:
    def __init__(self, job: AIJobRequest, *, timeout_seconds: float = 60.0):
        self.job = job
        self.timeout = timeout_seconds

    def _headers(self, callback_id: str) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.job.callback.token}",
            "Idempotency-Key": callback_id,
        }

    async def processing(self, *, progress: float | None = None, stage: str | None = None, message: str | None = None) -> httpx.Response:
        callback_id = str(uuid4())
        payload = {
            "schema_version": "1.0.0",
            "callback_id": callback_id,
            "ai_job_id": self.job.ai_job_id,
            "kind": "processing",
            "progress": progress,
            "stage": stage,
            "message": message,
        }
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(str(self.job.callback.url), headers=self._headers(callback_id), json={k: v for k, v in payload.items() if v is not None})
            response.raise_for_status()
            return response

    async def failed(self, *, code: str, message: str, retryable: bool, details: dict | None = None) -> httpx.Response:
        callback_id = str(uuid4())
        payload = {
            "schema_version": "1.0.0",
            "callback_id": callback_id,
            "ai_job_id": self.job.ai_job_id,
            "kind": "failed",
            "error": {"code": code, "message": message, "retryable": retryable, "details": details},
        }
        if details is None:
            payload["error"].pop("details")
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(str(self.job.callback.url), headers=self._headers(callback_id), json=payload)
            response.raise_for_status()
            return response

    async def completed(self, result: AnalysisResult, overlay: bytes | Path) -> httpx.Response:
        validate_passthrough(self.job, result)
        overlay_bytes = overlay.read_bytes() if isinstance(overlay, Path) else overlay
        validate_overlay_bytes(overlay_bytes)
        analysis_bytes = result.model_dump_json(exclude_none=True).encode()
        callback_id = str(uuid4())
        metadata = {
            "schema_version": "1.0.0",
            "callback_id": callback_id,
            "ai_job_id": self.job.ai_job_id,
            "kind": "completed",
            "analysis_sha256": hashlib.sha256(analysis_bytes).hexdigest(),
            "overlay_sha256": hashlib.sha256(overlay_bytes).hexdigest(),
            "analysis_bytes": str(len(analysis_bytes)),
            "overlay_bytes": str(len(overlay_bytes)),
        }
        files = {
            "metadata": (None, json.dumps(metadata), "application/json"),
            "analysis": ("analysis.json", analysis_bytes, "application/json"),
            "overlay": ("overlay.fb", overlay_bytes, "application/vnd.volleyball.overlay+flatbuffers;version=1"),
        }
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(str(self.job.callback.url), headers=self._headers(callback_id), files=files)
            response.raise_for_status()
            return response
