from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import logging
import os
import socket
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol
from uuid import uuid4

import httpx
from websockets.asyncio.client import ClientConnection, connect

from .callback import CallbackClient
from .models import AIJobRequest, AnalysisBundle, ProviderCapabilities
from .realtime import (
    AbortAckMessage,
    AbortJobMessage,
    ActiveJob,
    ConnectionReadyMessage,
    DiscardJobMessage,
    HeartbeatMessage,
    JobAcceptedMessage,
    JobOfferMessage,
    JobRejectedMessage,
    ProgressMessage,
    ProtocolErrorMessage,
    ProviderHello,
    parse_server_message,
)

LOGGER = logging.getLogger(__name__)
SDK_VERSION = "0.3.0"


class JobAbortedError(asyncio.CancelledError):
    """Raised at cooperative checkpoints after the central server aborts a job."""


class WorkerAuthorizationRevokedError(RuntimeError):
    """Raised when the central server permanently revokes this worker credential."""


class CancellationToken:
    def __init__(self) -> None:
        self._event = asyncio.Event()
        self._reason: str | None = None

    @property
    def is_aborted(self) -> bool:
        return self._event.is_set()

    @property
    def reason(self) -> str | None:
        return self._reason

    def abort(self, reason: str) -> None:
        self._reason = reason
        self._event.set()

    def raise_if_aborted(self) -> None:
        if self.is_aborted:
            raise JobAbortedError(self._reason or "job aborted")

    async def wait(self) -> str:
        await self._event.wait()
        return self._reason or "job aborted"


@dataclass(frozen=True, slots=True)
class WorkerConfig:
    server_ws_url: str
    token: str
    workspace: Path
    provider_build_id: str
    capabilities: ProviderCapabilities
    instance_id: str = field(default_factory=lambda: f"{socket.gethostname()}-{uuid4()}")
    max_concurrency: int = 1
    open_timeout_seconds: float = 15
    reconnect_min_seconds: float = 1
    reconnect_max_seconds: float = 30

    def __post_init__(self) -> None:
        if not self.server_ws_url.startswith(("ws://", "wss://")):
            raise ValueError("server_ws_url must use ws:// or wss://")
        if not self.token:
            raise ValueError("token must not be empty")
        if not 1 <= self.max_concurrency <= 64:
            raise ValueError("max_concurrency must be between 1 and 64")


class ClipDownloader:
    def __init__(self, *, timeout: httpx.Timeout | None = None) -> None:
        self.timeout = timeout or httpx.Timeout(connect=30, read=None, write=30, pool=30)

    async def download(
        self,
        job: AIJobRequest,
        destination: Path,
        cancellation: CancellationToken,
    ) -> Path:
        destination.parent.mkdir(parents=True, exist_ok=True)
        partial = destination.with_suffix(destination.suffix + ".part")
        partial.unlink(missing_ok=True)
        digest = hashlib.sha256()
        size = 0
        try:
            # The signed media URL is independent from the callback token.
            async with (
                httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client,
                client.stream("GET", str(job.clip.download_url)) as response,
            ):
                response.raise_for_status()
                with partial.open("wb") as handle:
                    async for chunk in response.aiter_bytes():
                        cancellation.raise_if_aborted()
                        digest.update(chunk)
                        size += len(chunk)
                        handle.write(chunk)
            cancellation.raise_if_aborted()
            if digest.hexdigest().lower() != job.clip.sha256.lower():
                raise ValueError("clip checksum mismatch")
            if size != int(job.clip.byte_length):
                raise ValueError("clip byte length mismatch")
            os.replace(partial, destination)
            return destination
        except BaseException:
            partial.unlink(missing_ok=True)
            raise


ProgressSender = Callable[[ProgressMessage], Awaitable[None]]


class JobContext:
    def __init__(
        self,
        *,
        job: AIJobRequest,
        delivery_id: str,
        workspace: Path,
        cancellation: CancellationToken,
        progress_sender: ProgressSender,
        downloader: ClipDownloader,
    ) -> None:
        self.job = job
        self.delivery_id = delivery_id
        self.workspace = workspace / job.ai_job_id
        self.cancellation = cancellation
        self._progress_sender = progress_sender
        self._downloader = downloader
        self._callback = CallbackClient(job)
        self._progress = 0.0

    @property
    def clip_path(self) -> Path:
        return self.workspace / "canonical.mp4"

    @property
    def progress(self) -> float:
        return self._progress

    async def download_clip(self) -> Path:
        self.cancellation.raise_if_aborted()
        await self.report_progress(0.01, "downloading_clip")
        path = await self._downloader.download(self.job, self.clip_path, self.cancellation)
        await self.report_progress(0.05, "clip_ready")
        return path

    async def report_progress(self, progress: float, stage: str | None = None) -> None:
        self.cancellation.raise_if_aborted()
        self._progress = max(self._progress, min(1.0, progress))
        await self._progress_sender(
            ProgressMessage(
                ai_job_id=self.job.ai_job_id,
                delivery_id=self.delivery_id,
                progress=self._progress,
                stage=stage,
            )
        )

    async def complete(self, bundle: AnalysisBundle) -> None:
        self.cancellation.raise_if_aborted()
        await self._callback.completed(bundle.result, bundle.overlay_bytes)

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


class JobHandler(Protocol):
    def __call__(self, context: JobContext) -> None | Awaitable[None]: ...


@dataclass(slots=True)
class _ActiveRun:
    context: JobContext
    task: asyncio.Task[None]


class AIWorkerClient:
    """Outbound-only AI worker controlled by the central server over WebSocket."""

    def __init__(self, config: WorkerConfig, *, downloader: ClipDownloader | None = None) -> None:
        self.config = config
        self._downloader = downloader or ClipDownloader()
        self._socket: ClientConnection | None = None
        self._send_lock = asyncio.Lock()
        self._active: dict[str, _ActiveRun] = {}
        self._stop = asyncio.Event()
        self._heartbeat_seconds = 10

    async def stop(self) -> None:
        self._stop.set()
        if self._socket is not None:
            await self._socket.close(code=1000, reason="worker stopping")
        for active in self._active.values():
            active.context.cancellation.abort("worker stopping")
            active.task.cancel()
        await asyncio.gather(*(run.task for run in self._active.values()), return_exceptions=True)

    async def run_forever(self, handler: JobHandler) -> None:
        self.config.workspace.mkdir(parents=True, exist_ok=True)
        delay = self.config.reconnect_min_seconds
        while not self._stop.is_set():
            try:
                async with connect(
                    self.config.server_ws_url,
                    additional_headers={"Authorization": f"Bearer {self.config.token}"},
                    open_timeout=self.config.open_timeout_seconds,
                    ping_interval=20,
                    ping_timeout=20,
                    max_size=2 * 1024 * 1024,
                ) as websocket:
                    self._socket = websocket
                    delay = self.config.reconnect_min_seconds
                    await self._send_hello()
                    heartbeat = asyncio.create_task(self._heartbeat_loop())
                    try:
                        async for raw in websocket:
                            if not isinstance(raw, (str, bytes)):
                                continue
                            await self._handle_message(raw, handler)
                    finally:
                        heartbeat.cancel()
                        await asyncio.gather(heartbeat, return_exceptions=True)
                        self._socket = None
            except asyncio.CancelledError:
                raise
            except WorkerAuthorizationRevokedError as exc:
                LOGGER.error("AI worker stopped by central server: %s", exc)
                await self.stop()
                return
            except Exception as exc:  # reconnect is the durable worker's normal failure mode
                if self._stop.is_set():
                    break
                LOGGER.warning("AI worker connection failed; retrying in %.1fs: %s", delay, exc)
                await asyncio.sleep(delay)
                delay = min(delay * 2, self.config.reconnect_max_seconds)

    async def _send_hello(self) -> None:
        active_jobs = [
            ActiveJob(
                ai_job_id=run.context.job.ai_job_id,
                delivery_id=run.context.delivery_id,
                progress=run.context.progress,
            )
            for run in self._active.values()
        ]
        await self._send(
            ProviderHello(
                instance_id=self.config.instance_id,
                sdk_version=SDK_VERSION,
                provider_build_id=self.config.provider_build_id,
                max_concurrency=self.config.max_concurrency,
                capabilities=self.config.capabilities,
                active_jobs=active_jobs,
            )
        )

    async def _heartbeat_loop(self) -> None:
        while not self._stop.is_set():
            await asyncio.sleep(self._heartbeat_seconds)
            active_jobs = [
                ActiveJob(
                    ai_job_id=run.context.job.ai_job_id,
                    delivery_id=run.context.delivery_id,
                    progress=run.context.progress,
                )
                for run in self._active.values()
            ]
            await self._send(
                HeartbeatMessage(instance_id=self.config.instance_id, active_jobs=active_jobs)
            )

    async def _handle_message(self, raw: str | bytes, handler: JobHandler) -> None:
        message = parse_server_message(raw)
        if isinstance(message, ConnectionReadyMessage):
            self._heartbeat_seconds = message.heartbeat_interval_seconds
            return
        if isinstance(message, JobOfferMessage):
            await self._accept_offer(message, handler)
            return
        if isinstance(message, AbortJobMessage):
            await self._abort(message.ai_job_id, message.delivery_id, message.reason)
            return
        if isinstance(message, DiscardJobMessage):
            await self._abort(message.ai_job_id, message.delivery_id, message.reason)
            return
        if isinstance(message, ProtocolErrorMessage):
            if not message.retryable:
                raise WorkerAuthorizationRevokedError(
                    f"server rejected worker protocol: {message.code}: {message.message}"
                )

    async def _accept_offer(self, offer: JobOfferMessage, handler: JobHandler) -> None:
        if offer.ai_job_id in self._active:
            await self._send(
                JobAcceptedMessage(
                    ai_job_id=offer.ai_job_id,
                    delivery_id=offer.delivery_id,
                    accepted_at=datetime.now(UTC),
                )
            )
            return
        if len(self._active) >= self.config.max_concurrency:
            await self._send(
                JobRejectedMessage(
                    ai_job_id=offer.ai_job_id,
                    delivery_id=offer.delivery_id,
                    code="WORKER_AT_CAPACITY",
                    message="worker has no free concurrency slot",
                    retryable=True,
                )
            )
            return
        cancellation = CancellationToken()
        context = JobContext(
            job=offer.job,
            delivery_id=offer.delivery_id,
            workspace=self.config.workspace,
            cancellation=cancellation,
            progress_sender=self._send_progress,
            downloader=self._downloader,
        )
        task = asyncio.create_task(self._run_handler(context, handler))
        self._active[offer.ai_job_id] = _ActiveRun(context=context, task=task)
        await self._send(
            JobAcceptedMessage(
                ai_job_id=offer.ai_job_id,
                delivery_id=offer.delivery_id,
                accepted_at=datetime.now(UTC),
            )
        )

    async def _run_handler(self, context: JobContext, handler: JobHandler) -> None:
        try:
            candidate = handler(context)
            if inspect.isawaitable(candidate):
                await candidate
        except (JobAbortedError, asyncio.CancelledError):
            LOGGER.info("AI job %s aborted: %s", context.job.ai_job_id, context.cancellation.reason)
        except Exception as exc:  # provider boundary must close non-aborted jobs
            LOGGER.exception("AI job %s failed", context.job.ai_job_id)
            try:
                await context.fail(
                    code="PROVIDER_ANALYSIS_FAILED",
                    message=str(exc)[:1000] or type(exc).__name__,
                    retryable=not isinstance(exc, (TypeError, ValueError)),
                    details={"exception_type": type(exc).__name__},
                )
            except Exception:
                LOGGER.exception("failed to send callback for AI job %s", context.job.ai_job_id)
        finally:
            self._active.pop(context.job.ai_job_id, None)

    async def _abort(self, ai_job_id: str, delivery_id: str, reason: str) -> None:
        run = self._active.get(ai_job_id)
        if run is not None and run.context.delivery_id == delivery_id:
            run.context.cancellation.abort(reason)
            run.task.cancel()
        await self._send(
            AbortAckMessage(
                ai_job_id=ai_job_id,
                delivery_id=delivery_id,
                acknowledged_at=datetime.now(UTC),
            )
        )

    async def _send(self, model: object) -> None:
        socket = self._socket
        if socket is None:
            raise ConnectionError("AI provider WebSocket is not connected")
        if hasattr(model, "model_dump_json"):
            payload = model.model_dump_json(exclude_none=True)  # type: ignore[attr-defined]
        else:
            payload = json.dumps(model)
        async with self._send_lock:
            await socket.send(payload)

    async def _send_progress(self, message: ProgressMessage) -> None:
        try:
            await self._send(message)
        except Exception as exc:
            # Progress is advisory. Heartbeat/resume re-advertises the latest value after reconnect.
            LOGGER.warning("progress update deferred until reconnect: %s", exc)
