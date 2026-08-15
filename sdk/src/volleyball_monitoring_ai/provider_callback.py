from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

import httpx

from .provider_work import ProviderWorkEnvelope


@dataclass(frozen=True, slots=True)
class ProviderResultArtifact:
    part_name: str
    kind: str
    schema_version: str
    content_type: str
    data: bytes | Path
    filename: str | None = None

    def read_bytes(self) -> bytes:
        return self.data.read_bytes() if isinstance(self.data, Path) else self.data


class ProviderWorkCallbackClient:
    def __init__(
        self,
        work: ProviderWorkEnvelope,
        *,
        timeout_seconds: float = 60.0,
        retry_delays_seconds: tuple[float, ...] = (0.5, 1.0, 2.0, 4.0),
    ) -> None:
        self.work = work
        self.timeout = timeout_seconds
        self.retry_delays = retry_delays_seconds

    def _headers(self, callback_id: str) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.work.callback.token}",
            "Idempotency-Key": callback_id,
        }

    async def _post(self, callback_id: str, **kwargs: object) -> httpx.Response:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            for attempt in range(len(self.retry_delays) + 1):
                try:
                    response = await client.post(
                        str(self.work.callback.url),
                        headers=self._headers(callback_id),
                        **kwargs,
                    )
                    if response.status_code not in {408, 425, 429} and response.status_code < 500:
                        if response.is_error:
                            detail = response.text.strip()[:1_000]
                            raise httpx.HTTPStatusError(
                                f"Provider callback rejected with {response.status_code}: {detail}",
                                request=response.request,
                                response=response,
                            )
                        return response
                    response.raise_for_status()
                    return response
                except (httpx.TransportError, httpx.HTTPStatusError) as error:
                    retryable_status = isinstance(error, httpx.HTTPStatusError) and (
                        error.response.status_code in {408, 425, 429}
                        or error.response.status_code >= 500
                    )
                    if attempt >= len(self.retry_delays) or (
                        isinstance(error, httpx.HTTPStatusError) and not retryable_status
                    ):
                        raise
                    await asyncio.sleep(self.retry_delays[attempt])
        raise RuntimeError("provider callback retry loop exited unexpectedly")

    async def processing(self, *, progress: float, stage: str | None = None) -> httpx.Response:
        callback_id = str(uuid4())
        payload = {
            "schema_version": "1.0.0",
            "callback_id": callback_id,
            "provider_job_id": self.work.provider_job_id,
            "work_kind": self.work.work_kind,
            "kind": "processing",
            "progress": progress,
            "stage": stage,
        }
        return await self._post(
            callback_id,
            json={key: value for key, value in payload.items() if value is not None},
        )

    async def failed(
        self,
        *,
        code: str,
        message: str,
        retryable: bool,
        details: dict | None = None,
    ) -> httpx.Response:
        callback_id = str(uuid4())
        error: dict[str, object] = {
            "code": code,
            "message": message,
            "retryable": retryable,
        }
        if details is not None:
            error["details"] = details
        return await self._post(
            callback_id,
            json={
                "schema_version": "1.0.0",
                "callback_id": callback_id,
                "provider_job_id": self.work.provider_job_id,
                "work_kind": self.work.work_kind,
                "kind": "failed",
                "error": error,
            },
        )

    async def completed(
        self,
        *,
        result_schema_version: str,
        artifacts: list[ProviderResultArtifact],
    ) -> httpx.Response:
        if not artifacts:
            raise ValueError("completed provider work requires at least one result artifact")
        part_names = [artifact.part_name for artifact in artifacts]
        if len(part_names) != len(set(part_names)):
            raise ValueError("result artifact part names must be unique")
        accepted = set(self.work.callback.accepted_result_kinds)
        unexpected = sorted({artifact.kind for artifact in artifacts} - accepted)
        if unexpected:
            raise ValueError(f"result artifact kinds were not accepted by Central: {unexpected}")

        metadata_artifacts: list[dict[str, str]] = []
        files: dict[str, tuple[str | None, bytes | str, str]] = {}
        for artifact in artifacts:
            data = artifact.read_bytes()
            metadata_artifacts.append(
                {
                    "part_name": artifact.part_name,
                    "kind": artifact.kind,
                    "schema_version": artifact.schema_version,
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "byte_length": str(len(data)),
                    "content_type": artifact.content_type,
                }
            )
            files[artifact.part_name] = (
                artifact.filename or f"{artifact.part_name}.bin",
                data,
                artifact.content_type,
            )

        callback_id = str(uuid4())
        metadata = {
            "schema_version": "1.0.0",
            "callback_id": callback_id,
            "provider_job_id": self.work.provider_job_id,
            "work_kind": self.work.work_kind,
            "kind": "completed",
            "result_schema_version": result_schema_version,
            "artifacts": metadata_artifacts,
        }
        files["metadata"] = (None, json.dumps(metadata), "application/json")
        return await self._post(callback_id, files=files)
