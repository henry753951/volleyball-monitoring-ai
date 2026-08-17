from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import logging
import os
import socket
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol
from uuid import uuid4

import httpx
from websockets.asyncio.client import ClientConnection, connect

from .provider_callback import ProviderResultArtifact, ProviderWorkCallbackClient
from .provider_work import (
    ProviderActiveWork,
    ProviderInputArtifact,
    ProviderWorkAbortAck,
    ProviderWorkAccepted,
    ProviderWorkActiveEnvelope,
    ProviderWorkCapabilities,
    ProviderWorkConnectionReady,
    ProviderWorkControl,
    ProviderWorkEnvelope,
    ProviderWorkFailure,
    ProviderWorkHello,
    ProviderWorkKind,
    ProviderWorkOffer,
    ProviderWorkProgress,
    ProviderWorkProtocolError,
    parse_provider_work_server_message,
)
from .worker import CancellationToken, JobAbortedError, WorkerAuthorizationRevokedError

LOGGER = logging.getLogger(__name__)
SDK_VERSION = "0.5.0"


@dataclass(frozen=True, slots=True)
class ProviderWorkerConfig:
    server_ws_url: str
    token: str
    workspace: Path
    provider_build_id: str
    capabilities: ProviderWorkCapabilities
    instance_id: str = field(default_factory=lambda: f"{socket.gethostname()}-{uuid4()}")
    open_timeout_seconds: float = 15
    reconnect_min_seconds: float = 1
    reconnect_max_seconds: float = 30

    def __post_init__(self) -> None:
        if not self.server_ws_url.startswith(("ws://", "wss://")):
            raise ValueError("server_ws_url must use ws:// or wss://")
        if not self.token:
            raise ValueError("token must not be empty")
        if self.provider_build_id != self.capabilities.provider_build_id:
            raise ValueError("provider build ID must match advertised capabilities")


class ProviderArtifactDownloader:
    def __init__(self, *, timeout: httpx.Timeout | None = None) -> None:
        self.timeout = timeout or httpx.Timeout(connect=30, read=None, write=30, pool=30)

    async def download(
        self,
        artifact: ProviderInputArtifact,
        destination: Path,
        cancellation: CancellationToken,
    ) -> Path:
        destination.parent.mkdir(parents=True, exist_ok=True)
        partial = destination.with_suffix(destination.suffix + ".part")
        partial.unlink(missing_ok=True)
        digest = hashlib.sha256()
        size = 0
        try:
            # Signed artifact authorization is deliberately independent from callback credentials.
            async with (
                httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client,
                client.stream("GET", str(artifact.download_url)) as response,
            ):
                response.raise_for_status()
                with partial.open("wb") as handle:
                    async for chunk in response.aiter_bytes():
                        cancellation.raise_if_aborted()
                        digest.update(chunk)
                        size += len(chunk)
                        handle.write(chunk)
            if digest.hexdigest().lower() != artifact.sha256.lower():
                raise ValueError(f"artifact checksum mismatch: {artifact.artifact_id}")
            if size != int(artifact.byte_length):
                raise ValueError(f"artifact byte length mismatch: {artifact.artifact_id}")
            cancellation.raise_if_aborted()
            os.replace(partial, destination)
            return destination
        except BaseException:
            partial.unlink(missing_ok=True)
            raise


ProgressSender = Callable[[ProviderWorkProgress], Awaitable[None]]


class ProviderWorkContext:
    def __init__(
        self,
        *,
        work: ProviderWorkEnvelope,
        delivery_id: str,
        workspace: Path,
        cancellation: CancellationToken,
        progress_sender: ProgressSender,
        downloader: ProviderArtifactDownloader,
    ) -> None:
        self.work = work
        self.delivery_id = delivery_id
        self.workspace = workspace / work.provider_job_id
        self.cancellation = cancellation
        self._progress_sender = progress_sender
        self._downloader = downloader
        self._callback = ProviderWorkCallbackClient(work)
        self._progress = 0.0

    @property
    def progress(self) -> float:
        return self._progress

    def input_artifact(self, artifact_id: str) -> ProviderInputArtifact:
        for artifact in self.work.input_artifacts:
            if artifact.artifact_id == artifact_id:
                return artifact
        raise KeyError(f"provider work does not contain artifact {artifact_id}")

    async def download_artifact(
        self,
        artifact_id: str,
        *,
        filename: str | None = None,
    ) -> Path:
        artifact = self.input_artifact(artifact_id)
        path = self.workspace / "inputs" / (filename or artifact.artifact_id)
        return await self._downloader.download(artifact, path, self.cancellation)

    async def report_progress(self, progress: float, stage: str | None = None) -> None:
        self.cancellation.raise_if_aborted()
        self._progress = max(self._progress, min(1.0, progress))
        await self._progress_sender(
            ProviderWorkProgress(
                schema_version="2.0.0",
                type="progress",
                provider_job_id=self.work.provider_job_id,
                work_kind=self.work.work_kind,
                delivery_id=self.delivery_id,
                progress=self._progress,
                stage=stage,
            )
        )

    async def complete(
        self,
        *,
        result_schema_version: str,
        artifacts: list[ProviderResultArtifact],
    ) -> None:
        self.cancellation.raise_if_aborted()
        await self._callback.completed(
            result_schema_version=result_schema_version,
            artifacts=artifacts,
        )

    async def fail(
        self,
        *,
        code: str,
        message: str,
        retryable: bool,
        details: dict | None = None,
    ) -> None:
        if not self.cancellation.is_aborted:
            await self._callback.failed(
                code=code,
                message=message,
                retryable=retryable,
                details=details,
            )


class ProviderWorkHandler(Protocol):
    def __call__(self, context: ProviderWorkContext) -> None | Awaitable[None]: ...


@dataclass(slots=True)
class _ActiveProviderWork:
    context: ProviderWorkContext
    task: asyncio.Task[None]


class ProviderWorkerClient:
    """Capability-gated multi-work outbound provider client (Realtime 2.0.0)."""

    def __init__(
        self,
        config: ProviderWorkerConfig,
        *,
        downloader: ProviderArtifactDownloader | None = None,
    ) -> None:
        self.config = config
        self._downloader = downloader or ProviderArtifactDownloader()
        self._socket: ClientConnection | None = None
        self._send_lock = asyncio.Lock()
        self._active: dict[str, _ActiveProviderWork] = {}
        self._stop = asyncio.Event()
        self._heartbeat_seconds = 10
        self._capabilities = {
            capability.work_kind: capability for capability in config.capabilities.work_capabilities
        }

    async def stop(self) -> None:
        self._stop.set()
        if self._socket is not None:
            await self._socket.close(code=1000, reason="worker stopping")
        for active in self._active.values():
            active.context.cancellation.abort("worker stopping")
            active.task.cancel()
        await asyncio.gather(*(run.task for run in self._active.values()), return_exceptions=True)

    async def run_forever(self, handlers: Mapping[ProviderWorkKind, ProviderWorkHandler]) -> None:
        unknown = set(handlers) - set(self._capabilities)
        if unknown:
            raise ValueError(
                f"handlers were registered for unadvertised work kinds: {sorted(unknown)}"
            )
        self.config.workspace.mkdir(parents=True, exist_ok=True)
        delay = self.config.reconnect_min_seconds
        while not self._stop.is_set():
            try:
                async with connect(
                    self.config.server_ws_url,
                    additional_headers={"Authorization": f"Bearer {self.config.token}"},
                    open_timeout=self.config.open_timeout_seconds,
                    # Realtime 2.0.0 already sends an application heartbeat negotiated by
                    # Central. Rely on that heartbeat for liveness so reverse proxies that
                    # don't return protocol-level pong frames cannot force reconnect loops.
                    ping_interval=None,
                    ping_timeout=None,
                    max_size=2 * 1024 * 1024,
                ) as websocket:
                    self._socket = websocket
                    delay = self.config.reconnect_min_seconds
                    await self._send_hello()
                    heartbeat = asyncio.create_task(self._heartbeat_loop())
                    try:
                        async for raw in websocket:
                            if isinstance(raw, (str, bytes)):
                                await self._handle_message(raw, handlers)
                    finally:
                        heartbeat.cancel()
                        await asyncio.gather(heartbeat, return_exceptions=True)
                        self._socket = None
            except asyncio.CancelledError:
                raise
            except WorkerAuthorizationRevokedError as exc:
                LOGGER.error("provider worker stopped by Central: %s", exc)
                await self.stop()
                return
            except Exception as exc:
                if self._stop.is_set():
                    break
                LOGGER.warning(
                    "provider worker connection failed; retrying in %.1fs: %s", delay, exc
                )
                await asyncio.sleep(delay)
                delay = min(delay * 2, self.config.reconnect_max_seconds)

    def _active_payload(self) -> list[ProviderActiveWork]:
        return [
            ProviderActiveWork(
                provider_job_id=run.context.work.provider_job_id,
                work_kind=run.context.work.work_kind,
                delivery_id=run.context.delivery_id,
                progress=run.context.progress,
            )
            for run in self._active.values()
        ]

    async def _send_hello(self) -> None:
        await self._send(
            ProviderWorkHello(
                schema_version="2.0.0",
                type="provider_hello",
                instance_id=self.config.instance_id,
                sdk_version=SDK_VERSION,
                provider_build_id=self.config.provider_build_id,
                capabilities=self.config.capabilities,
                active_work=self._active_payload(),
            )
        )

    async def _heartbeat_loop(self) -> None:
        while not self._stop.is_set():
            await asyncio.sleep(self._heartbeat_seconds)
            await self._send(
                ProviderWorkActiveEnvelope(
                    schema_version="2.0.0",
                    type="heartbeat",
                    instance_id=self.config.instance_id,
                    active_work=self._active_payload(),
                )
            )

    async def _handle_message(
        self,
        raw: str | bytes,
        handlers: Mapping[ProviderWorkKind, ProviderWorkHandler],
    ) -> None:
        payload = json.loads(raw.decode() if isinstance(raw, bytes) else raw)
        message = parse_provider_work_server_message(payload)
        if isinstance(message, ProviderWorkConnectionReady):
            self._heartbeat_seconds = message.heartbeat_interval_seconds
        elif isinstance(message, ProviderWorkOffer):
            await self._accept_offer(message, handlers)
        elif isinstance(message, ProviderWorkControl):
            await self._abort(
                message.provider_job_id,
                message.work_kind,
                message.delivery_id,
                message.reason,
                acknowledge=message.type == "abort_job",
            )
        elif isinstance(message, ProviderWorkProtocolError):
            if message.code == "AUTHORIZATION_REVOKED":
                raise WorkerAuthorizationRevokedError(
                    f"server rejected provider protocol: {message.code}: {message.message}"
                )
            LOGGER.warning(
                "Central reported provider protocol error %s (retryable=%s): %s",
                message.code,
                message.retryable,
                message.message,
            )

    async def _accept_offer(
        self,
        offer: ProviderWorkOffer,
        handlers: Mapping[ProviderWorkKind, ProviderWorkHandler],
    ) -> None:
        if offer.provider_job_id in self._active:
            await self._send_acceptance(offer)
            return
        capability = self._capabilities.get(offer.work_kind)
        handler = handlers.get(offer.work_kind)
        if capability is None or handler is None:
            await self._reject(offer, "UNSUPPORTED_WORK_KIND", "worker has no handler", False)
            return
        if offer.work.request_schema_version not in capability.request_schema_versions:
            await self._reject(
                offer,
                "UNSUPPORTED_REQUEST_SCHEMA",
                f"unsupported request schema {offer.work.request_schema_version}",
                False,
            )
            return
        accepted_artifacts = set(capability.accepted_input_artifact_kinds)
        unexpected = sorted(
            {artifact.kind for artifact in offer.work.input_artifacts} - accepted_artifacts
        )
        if unexpected:
            await self._reject(
                offer,
                "UNSUPPORTED_INPUT_ARTIFACT",
                f"unsupported input artifact kinds: {unexpected}",
                False,
            )
            return
        active_for_kind = sum(
            run.context.work.work_kind == offer.work_kind for run in self._active.values()
        )
        if active_for_kind >= capability.max_concurrency:
            await self._reject(offer, "WORKER_AT_CAPACITY", "work-kind capacity reached", True)
            return

        cancellation = CancellationToken()
        context = ProviderWorkContext(
            work=offer.work,
            delivery_id=offer.delivery_id,
            workspace=self.config.workspace,
            cancellation=cancellation,
            progress_sender=self._send_progress,
            downloader=self._downloader,
        )
        task = asyncio.create_task(self._run_handler(context, handler))
        self._active[offer.provider_job_id] = _ActiveProviderWork(context=context, task=task)
        await self._send_acceptance(offer)

    async def _send_acceptance(self, offer: ProviderWorkOffer) -> None:
        await self._send(
            ProviderWorkAccepted(
                schema_version="2.0.0",
                type="job_accepted",
                provider_job_id=offer.provider_job_id,
                work_kind=offer.work_kind,
                delivery_id=offer.delivery_id,
                accepted_at=datetime.now(UTC),
            )
        )

    async def _reject(
        self,
        offer: ProviderWorkOffer,
        code: str,
        message: str,
        retryable: bool,
    ) -> None:
        await self._send(
            ProviderWorkFailure(
                schema_version="2.0.0",
                type="job_rejected",
                provider_job_id=offer.provider_job_id,
                work_kind=offer.work_kind,
                delivery_id=offer.delivery_id,
                code=code,
                message=message,
                retryable=retryable,
            )
        )

    async def _run_handler(
        self,
        context: ProviderWorkContext,
        handler: ProviderWorkHandler,
    ) -> None:
        try:
            candidate = handler(context)
            if inspect.isawaitable(candidate):
                await candidate
        except (JobAbortedError, asyncio.CancelledError):
            LOGGER.info(
                "provider work %s aborted: %s",
                context.work.provider_job_id,
                context.cancellation.reason,
            )
        except Exception as exc:
            LOGGER.exception("provider work %s failed", context.work.provider_job_id)
            try:
                await context.fail(
                    code="PROVIDER_WORK_FAILED",
                    message=str(exc)[:1000] or type(exc).__name__,
                    retryable=not isinstance(exc, (TypeError, ValueError)),
                    details={"exception_type": type(exc).__name__},
                )
            except Exception:
                LOGGER.exception(
                    "failed to callback provider work %s", context.work.provider_job_id
                )
        finally:
            self._active.pop(context.work.provider_job_id, None)

    async def _abort(
        self,
        provider_job_id: str,
        work_kind: ProviderWorkKind,
        delivery_id: str,
        reason: str,
        *,
        acknowledge: bool = True,
    ) -> None:
        run = self._active.get(provider_job_id)
        if run is not None and run.context.delivery_id == delivery_id:
            run.context.cancellation.abort(reason)
            run.task.cancel()
        if acknowledge:
            await self._send(
                ProviderWorkAbortAck(
                    schema_version="2.0.0",
                    type="abort_ack",
                    provider_job_id=provider_job_id,
                    work_kind=work_kind,
                    delivery_id=delivery_id,
                    acknowledged_at=datetime.now(UTC),
                )
            )

    async def _send(self, model: object) -> None:
        socket = self._socket
        if socket is None:
            raise ConnectionError("provider WebSocket is not connected")
        if not hasattr(model, "model_dump_json"):
            raise TypeError("provider realtime messages must be Pydantic models")
        payload = model.model_dump_json(exclude_none=True)  # type: ignore[attr-defined]
        async with self._send_lock:
            await socket.send(payload)

    async def _send_progress(self, message: ProviderWorkProgress) -> None:
        try:
            await self._send(message)
        except Exception as exc:
            LOGGER.warning("provider progress deferred until reconnect: %s", exc)
