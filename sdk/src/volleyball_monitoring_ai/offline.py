"""No-network execution helpers for local AI development."""

from __future__ import annotations

import hashlib
import inspect
import json
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TypeAlias

from .models import AIJobRequest, AnalysisDataBundle, KeyPointInput
from .validation import validate_passthrough

OfflineProgressReporter: TypeAlias = Callable[[float, str], None]
OfflineAnalyzer: TypeAlias = Callable[
    [AIJobRequest, Path, OfflineProgressReporter],
    AnalysisDataBundle | Awaitable[AnalysisDataBundle],
]


@dataclass(frozen=True, slots=True)
class OfflineRunResult:
    """Paths and typed values produced by one local run."""

    job: AIJobRequest
    bundle: AnalysisDataBundle
    output_dir: Path
    analysis_data_path: Path
    manifest_path: Path


class OfflineRunner:
    """Run the same provider analyzer locally without HTTP or WebSocket clients."""

    def __init__(self, *, verify_clip: bool = True) -> None:
        self.verify_clip = verify_clip

    @staticmethod
    def load_job(job_path: Path, key_points_path: Path | None = None) -> AIJobRequest:
        """Load an online-shaped job and optionally replace its human key-point list."""
        payload: dict[str, Any] = json.loads(job_path.read_text(encoding="utf-8"))
        if key_points_path is not None:
            key_point_payload: object = json.loads(key_points_path.read_text(encoding="utf-8"))
            if isinstance(key_point_payload, dict):
                key_point_payload = key_point_payload.get("key_points")
            if not isinstance(key_point_payload, list):
                raise ValueError("key-point file must be a JSON list or an object with key_points")
            payload["key_points"] = [
                KeyPointInput.model_validate(item).model_dump(mode="json")
                for item in key_point_payload
            ]
        return AIJobRequest.model_validate(payload)

    async def run(
        self,
        *,
        job_path: Path,
        clip_path: Path,
        output_dir: Path,
        analyzer: OfflineAnalyzer,
        key_points_path: Path | None = None,
        progress: OfflineProgressReporter | None = None,
    ) -> OfflineRunResult:
        """Validate inputs, run an analyzer, and atomically write wire artifacts."""
        job = self.load_job(job_path, key_points_path)
        resolved_clip = clip_path.expanduser().resolve(strict=True)
        reporter = progress or (lambda _progress, _stage: None)
        if self.verify_clip:
            self._verify_clip(job, resolved_clip)

        reporter(0.0, "offline_inputs_ready")
        candidate = analyzer(job, resolved_clip, reporter)
        bundle = await candidate if inspect.isawaitable(candidate) else candidate
        validate_passthrough(job, bundle.domain)

        resolved_output = output_dir.expanduser().resolve()
        resolved_output.mkdir(parents=True, exist_ok=True)
        analysis_data_path = resolved_output / "analysis-data.vad1"
        manifest_path = resolved_output / "offline-run.json"
        self._atomic_write_bytes(analysis_data_path, bundle.analysis_data_bytes)
        manifest = {
            "schema_version": "1.0.0",
            "mode": "offline",
            "network_used": False,
            "ai_job_id": job.ai_job_id,
            "clip_path": str(resolved_clip),
            "job_path": str(job_path.expanduser().resolve()),
            "key_points_path": (
                str(key_points_path.expanduser().resolve()) if key_points_path else None
            ),
            "analysis_data_path": analysis_data_path.name,
        }
        self._atomic_write_text(
            manifest_path,
            json.dumps(manifest, ensure_ascii=False, indent=2),
        )
        reporter(1.0, "offline_artifacts_written")
        return OfflineRunResult(
            job=job,
            bundle=bundle,
            output_dir=resolved_output,
            analysis_data_path=analysis_data_path,
            manifest_path=manifest_path,
        )

    @staticmethod
    def _verify_clip(job: AIJobRequest, clip_path: Path) -> None:
        actual_size = clip_path.stat().st_size
        expected_size = int(job.clip.byte_length)
        if actual_size != expected_size:
            raise ValueError(
                f"clip byte length mismatch: expected {expected_size}, got {actual_size}"
            )
        digest = hashlib.sha256()
        with clip_path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        if digest.hexdigest().lower() != job.clip.sha256.lower():
            raise ValueError("clip SHA-256 mismatch")

    @staticmethod
    def _atomic_write_text(path: Path, value: str) -> None:
        OfflineRunner._atomic_write_bytes(path, value.encode("utf-8"))

    @staticmethod
    def _atomic_write_bytes(path: Path, value: bytes) -> None:
        temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        temporary.write_bytes(value)
        temporary.replace(path)
