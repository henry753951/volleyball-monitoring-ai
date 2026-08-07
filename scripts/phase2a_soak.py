from __future__ import annotations

import argparse
import json
import os
import signal
import ssl
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

SERVICES = 14
EXPECTED_SERVICES = {"fake-ai-provider", "mediamtx", "minio", "postgres", "redis", "server", "traefik", "web", "worker-ai-dispatcher", "worker-analysis-ingest", "worker-clip", "worker-media-indexer", "worker-outbox", "worker-playback"}
_STOP = False

def restart_delta(current: int, baseline: int) -> int:
    return max(0, current - baseline)

def validate_config(args: argparse.Namespace, session_id: str) -> None:
    if args.duration_seconds <= 0 or args.interval_seconds <= 0 or args.memory_cap_mib <= 0 or args.growth_cap_mib <= 0:
        raise ValueError("duration, interval, and caps must be positive")
    import re
    if not re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", session_id):
        raise ValueError("capture session ID must be a UUID")


def docker(*args: str) -> str:
    return subprocess.check_output(["docker", *args], text=True, stderr=subprocess.STDOUT)


def compose_state() -> tuple[int, int, int, dict[str, dict[str, str]]]:
    rows = docker("ps", "-a", "--filter", "label=com.docker.compose.project=volleyball-monitoring-ai",
                  "--format", "{{.Names}}\t{{.Label \"com.docker.compose.service\"}}\t{{.State}}\t{{.Status}}").splitlines()
    services: dict[str, dict[str, str]] = {}
    restarts = 0
    unhealthy = 0
    for row in rows:
        parts = row.split("\t", 3)
        if len(parts) < 4 or parts[1] in services:
            continue
        container, name, state, status = parts
        try:
            inspect = docker("inspect", "-f", "{{.RestartCount}}\t{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", container).strip().split("\t")
            restart_count = int(inspect[0])
            health = inspect[1] if len(inspect) > 1 else "none"
        except (ValueError, subprocess.SubprocessError):
            restart_count, health = 0, "unknown"
        restarts += restart_count
        unhealthy += int(health in {"unhealthy", "unknown"})
        services[name] = {"container": container, "state": state, "health": health, "status": status, "restarts": str(restart_count)}
    # minio-init is a completed one-shot bootstrap, not a continuously running service.
    services.pop("minio-init", None)
    running = sum(item["state"] == "running" for item in services.values())
    return running, restarts, unhealthy, services


def parse_memory(value: str) -> float:
    value = value.strip().replace(",", "")
    units = {"B": 1 / 1048576, "KiB": 1 / 1024, "MiB": 1, "GiB": 1024, "TiB": 1048576}
    for unit, factor in sorted(units.items(), key=lambda item: len(item[0]), reverse=True):
        if value.endswith(unit):
            return float(value[: -len(unit)].strip()) * factor
    return 0.0


def parse_stats(text: str) -> list[dict[str, float]]:
    rows: list[dict[str, float]] = []
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("NAME"):
            continue
        parts = [part.strip() for part in line.split("\t")]
        if len(parts) < 3:
            parts = line.split()
        if len(parts) < 3:
            continue
        try:
            rows.append({"cpu_pct": float(parts[1].rstrip("%")), "mem_mib": parse_memory(parts[2].split("/")[0])})
        except (ValueError, IndexError):
            continue
    return rows


def parse_manifest(text: str) -> list[str]:
    uris: list[str] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("#EXT-X-MAP:"):
            marker = line.split("URI=", 1)[-1]
            uri = marker.strip().strip('"').strip("'").strip().split(",", 1)[0]
        elif line.startswith("#"):
            continue
        else:
            uri = line.strip().strip('"').strip("'").strip()
        if uri:
            if uri not in uris:
                uris.append(uri)
    return uris


def summarize(samples: list[dict[str, Any]], cap_mib: float, growth_mib: float) -> dict[str, Any]:
    mem = [float(item.get("memory_mib", 0)) for item in samples]
    restarts = max((int(item.get("restarts_delta", item.get("restarts", 0))) for item in samples), default=0)
    health_failures = sum(int(item.get("health_failures", 0)) for item in samples)
    api_failures = sum(int(item.get("api_failures", 0)) for item in samples)
    maximum = max(mem, default=0.0)
    growth = max(mem, default=0.0) - min(mem, default=0.0)
    failures: list[str] = []
    if not samples:
        failures.append("no_samples")
    if maximum > cap_mib:
        failures.append("memory_cap")
    if growth > growth_mib:
        failures.append("memory_growth")
    if restarts:
        failures.append("container_restart")
    if health_failures:
        failures.append("container_health")
    if api_failures:
        failures.append("api_failure")
    return {"samples": len(samples), "max_memory_mib": maximum, "growth_mib": growth,
            "restarts": restarts, "health_failures": health_failures, "api_failures": api_failures, "failures": failures,
            "passed": not failures}


def http_json(url: str, payload: dict[str, Any], headers: dict[str, str], context: ssl.SSLContext) -> tuple[int, bytes]:
    request = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={**headers, "content-type": "application/json"})
    try:
        with urllib.request.urlopen(request, context=context, timeout=15) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def decimal(value: Any) -> bool:
    return isinstance(value, str) and value.isdecimal()

def validate_anchor(anchor: dict[str, Any], capture: str, mapping: int) -> None:
    if anchor.get("capture_session_id") != capture or anchor.get("mapping_version") != mapping:
        raise ValueError("anchor identity mismatch")
    for key in ("capture_time_us", "capture_frame_index", "resolved_player_media_time_us"):
        if not decimal(anchor.get(key)):
            raise ValueError("invalid anchor decimal")
    if not isinstance(anchor.get("source_pts"), str) or not anchor["source_pts"].lstrip("-").isdigit():
        raise ValueError("invalid source pts")
    if "snap_distance_us" in anchor and anchor["snap_distance_us"] is not None and not decimal(anchor["snap_distance_us"]):
        raise ValueError("invalid snap distance")


def expected_error(status: int, raw: bytes, statuses: set[int], codes: set[str]) -> bool:
    try:
        body = json.loads(raw)
        return status in statuses and (body.get("error", {}).get("code") in codes or body.get("code") in codes)
    except (ValueError, AttributeError):
        return False


def exercise_api(base: str, session_id: str, headers: dict[str, str], context: ssl.SSLContext) -> int:
    failures = 0
    archive_target = os.getenv("PHASE2A_ARCHIVE_TARGET_US")
    midpoint = "0"
    for mode in ("live", "archive"):
        target = None if mode == "live" else (archive_target or midpoint)
        body: dict[str, Any] = {"schema_version": "1.0.0", "capture_session_id": session_id, "mode": mode}
        if target is not None:
            body["target_capture_time_us"] = target
        status, raw = http_json(f"{base}/api/v1/media/playback-windows", body, headers, context)
        if status != 200:
            return failures + 1
        try:
            descriptor = json.loads(raw)
            required = ("playback_window_id", "capture_session_id", "mapping_version", "target_player_media_time_us", "window_capture_start_us", "window_capture_end_us")
            if any(key not in descriptor for key in required) or any(not decimal(descriptor[key]) for key in ("target_player_media_time_us", "window_capture_start_us", "window_capture_end_us")):
                raise ValueError("invalid descriptor wire values")
            window = descriptor["playback_window_id"]
            mapping = descriptor["mapping_version"]
            capture = descriptor["capture_session_id"]
            if mode == "live":
                midpoint = str((int(descriptor["window_capture_start_us"]) + int(descriptor["window_capture_end_us"])) // 2)
            manifest_url = urllib.parse.urljoin(base + "/", descriptor["manifest_url"])
            with urllib.request.urlopen(urllib.request.Request(manifest_url, headers=headers), context=context, timeout=15) as response:
                manifest = response.read().decode("utf-8", "replace")
            uris = parse_manifest(manifest)
            if len(uris) < 2:
                raise ValueError("manifest has no init/media pair")
            for uri in uris[:2]:
                absolute = urllib.parse.urljoin(manifest_url, uri)
                with urllib.request.urlopen(urllib.request.Request(absolute, headers=headers), context=context, timeout=15) as response:
                    length = int(response.headers.get("Content-Length", "0"))
                    if length <= 0 or length > 2_000_000_000 or response.headers.get("Content-Type", "").split(";", 1)[0] != "video/mp4":
                        raise ValueError("empty media object")
                    response.read(1)
            cursor = {"schema_version": "1.0.0", "playback_window_id": window, "mapping_version": mapping,
                      "player_media_time_us": descriptor["target_player_media_time_us"], "observation_source": "current_time_fallback",
                      "seek_generation": 0, "cursor_status": "ready"}
            status, raw = http_json(f"{base}/api/v1/media/resolve-cursor", cursor, headers, context)
            if status != 200:
                raise ValueError("cursor resolve failed")
            anchor = json.loads(raw)
            validate_anchor(anchor, capture, mapping)
            for direction in (("previous", "next") if mode == "archive" else ("previous",)):
                step = {"schema_version": "1.0.0", "capture_session_id": capture, "playback_window_id": window,
                        "mapping_version": mapping, "capture_frame_index": anchor["capture_frame_index"], "direction": direction}
                step_status, _ = http_json(f"{base}/api/v1/media/frame-step", step, headers, context)
                if step_status != 200:
                    raise ValueError(f"{direction} frame-step failed")
            edge = {"schema_version": "1.0.0", "capture_session_id": capture, "playback_window_id": window,
                    "mapping_version": mapping, "capture_frame_index": anchor["capture_frame_index"], "direction": "next"}
            edge_status, edge_raw = http_json(f"{base}/api/v1/media/frame-step", edge, headers, context)
            if mode == "live" and not expected_error(edge_status, edge_raw, {409, 422}, {"WINDOW_BOUNDARY", "SAMPLE_NOT_FOUND"}):
                failures += 1
        except (KeyError, ValueError, json.JSONDecodeError, urllib.error.URLError):
            failures += 1
    return failures


def install_signal_handlers() -> None:
    def stop(_signum: int, _frame: Any) -> None:
        global _STOP
        _STOP = True
    signal.signal(signal.SIGINT, stop)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, stop)


def main() -> int:
    global _STOP
    parser = argparse.ArgumentParser()
    parser.add_argument("--duration-seconds", type=int, default=60)
    parser.add_argument("--interval-seconds", type=int, default=10)
    parser.add_argument("--memory-cap-mib", type=float, default=2048)
    parser.add_argument("--growth-cap-mib", type=float, default=256)
    parser.add_argument("--output", default=os.path.join(os.environ.get("TEMP", "."), "phase2a-soak.jsonl"))
    parser.add_argument("--capture-session-id", default=None)
    args = parser.parse_args()
    install_signal_handlers()
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    base = os.getenv("PHASE2A_API_BASE", "https://127.0.0.1")
    headers = {"x-dev-user-id": os.getenv("DEV_USER_ID", "00000000-0000-4000-8000-000000000001"), "x-dev-role": "ADMIN"}
    session_id = os.getenv("PHASE2A_CAPTURE_SESSION_ID", "00000000-0000-4000-8000-00000000d003")
    if args.capture_session_id:
        session_id = args.capture_session_id
    try:
        validate_config(args, session_id)
    except ValueError as error:
        parser.error(str(error))
    context = ssl.create_default_context()
    if urllib.parse.urlparse(base).hostname == "127.0.0.1":
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
    samples: list[dict[str, Any]] = []
    started = time.monotonic()
    restart_baseline: int | None = None
    with output.open("a", encoding="utf-8") as stream:
        while not _STOP and time.monotonic() - started < args.duration_seconds:
            running, restarts, unhealthy, services = compose_state()
            stats = parse_stats(docker("stats", "--no-stream", *(item["container"] for item in services.values()),
                                       "--format", "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"))
            row: dict[str, Any] = {"ts": time.time(), "services_running": running, "memory_mib": sum(x["mem_mib"] for x in stats),
                                   "cpu_pct": sum(x["cpu_pct"] for x in stats), "restarts": restarts, "restarts_delta": 0, "health_failures": unhealthy, "api_failures": 0, "services": services}
            if restart_baseline is None:
                restart_baseline = restarts
            row["restarts_delta"] = restart_delta(restarts, restart_baseline)
            row["api_failures"] += exercise_api(base, session_id, headers, context)
            names = set(services)
            if names != EXPECTED_SERVICES:
                row["api_failures"] += 1
            samples.append(row); stream.write(json.dumps(row) + "\n"); stream.flush()
            if not _STOP:
                time.sleep(max(1, args.interval_seconds))
    summary = summarize(samples, args.memory_cap_mib, args.growth_cap_mib)
    print(json.dumps(summary, sort_keys=True))
    return 0 if summary["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
