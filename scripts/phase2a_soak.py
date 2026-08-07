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
_STOP = False


def docker(*args: str) -> str:
    return subprocess.check_output(["docker", *args], text=True, stderr=subprocess.STDOUT)


def compose_state() -> tuple[int, int, int]:
    rows = docker("ps", "-a", "--format", "{{.Names}}\t{{.State}}\t{{.Status}}").splitlines()
    running = sum("\trunning\t" in f"\t{row}\t" for row in rows)
    restarts = 0
    unhealthy = 0
    for row in rows:
        name = row.split("\t", 1)[0].strip()
        if "(unhealthy)" in row.lower():
            unhealthy += 1
        try:
            restarts += int(docker("inspect", "-f", "{{.RestartCount}}", name).strip())
        except (ValueError, subprocess.SubprocessError):
            unhealthy += 1
    return running, restarts, unhealthy


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
        if not line or line.startswith("#"):
            continue
        uri = line.strip().strip('"').strip("'").strip()
        if uri:
            uris.append(uri)
    return uris


def summarize(samples: list[dict[str, Any]], cap_mib: float, growth_mib: float) -> dict[str, Any]:
    mem = [float(item.get("memory_mib", 0)) for item in samples]
    restarts = sum(int(item.get("restarts", 0)) for item in samples)
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


def exercise_api(base: str, session_id: str, headers: dict[str, str], context: ssl.SSLContext) -> int:
    failures = 0
    for mode, target in (("live", None), ("archive", os.getenv("PHASE2A_ARCHIVE_TARGET_US", "0"))):
        body: dict[str, Any] = {"schema_version": "1.0.0", "capture_session_id": session_id, "mode": mode}
        if target is not None:
            body["target_capture_time_us"] = target
        status, raw = http_json(f"{base}/api/v1/media/playback-windows", body, headers, context)
        if status != 200:
            return failures + 1
        try:
            descriptor = json.loads(raw)
            window = descriptor["playback_window_id"]
            mapping = descriptor["mapping_version"]
            capture = descriptor["capture_session_id"]
            manifest_url = urllib.parse.urljoin(base + "/", descriptor["manifest_url"])
            with urllib.request.urlopen(urllib.request.Request(manifest_url, headers=headers), context=context, timeout=15) as response:
                manifest = response.read().decode("utf-8", "replace")
            uris = parse_manifest(manifest)
            if len(uris) < 2:
                raise ValueError("manifest has no init/media pair")
            for uri in uris[:2]:
                absolute = urllib.parse.urljoin(manifest_url, uri)
                with urllib.request.urlopen(urllib.request.Request(absolute, headers=headers), context=context, timeout=15) as response:
                    if int(response.headers.get("Content-Length", "0")) <= 0:
                        raise ValueError("empty media object")
                    response.read(1)
            cursor = {"schema_version": "1.0.0", "playback_window_id": window, "mapping_version": mapping,
                      "player_media_time_us": descriptor["target_player_media_time_us"], "observation_source": "current_time_fallback",
                      "seek_generation": 0, "cursor_status": "ready"}
            status, raw = http_json(f"{base}/api/v1/media/resolve-cursor", cursor, headers, context)
            if status != 200:
                raise ValueError("cursor resolve failed")
            anchor = json.loads(raw)
            for direction in ("previous", "next"):
                step = {"schema_version": "1.0.0", "capture_session_id": capture, "playback_window_id": window,
                        "mapping_version": mapping, "capture_frame_index": anchor["capture_frame_index"], "direction": direction}
                step_status, _ = http_json(f"{base}/api/v1/media/frame-step", step, headers, context)
                if step_status != 200:
                    raise ValueError(f"{direction} frame-step failed")
            edge = {"schema_version": "1.0.0", "capture_session_id": capture, "playback_window_id": window,
                    "mapping_version": mapping, "capture_frame_index": anchor["capture_frame_index"], "direction": "next"}
            edge_status, _ = http_json(f"{base}/api/v1/media/frame-step", edge, headers, context)
            if descriptor.get("live_edge_capture_time_us") is not None and edge_status == 200:
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
    args = parser.parse_args()
    install_signal_handlers()
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    base = os.getenv("PHASE2A_API_BASE", "https://127.0.0.1")
    headers = {"x-dev-user-id": os.getenv("DEV_USER_ID", "00000000-0000-4000-8000-000000000001"), "x-dev-role": "ADMIN"}
    context = ssl._create_unverified_context() if urllib.parse.urlparse(base).hostname == "127.0.0.1" else ssl.create_default_context()
    sessions = [os.getenv("PHASE2A_D001_SESSION_ID"), os.getenv("PHASE2A_D003_SESSION_ID")]
    samples: list[dict[str, Any]] = []
    started = time.monotonic()
    with output.open("a", encoding="utf-8") as stream:
        while not _STOP and time.monotonic() - started < args.duration_seconds:
            running, restarts, unhealthy = compose_state()
            stats = parse_stats(docker("stats", "--no-stream", "--format", "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"))
            row: dict[str, Any] = {"ts": time.time(), "services_running": running, "memory_mib": sum(x["mem_mib"] for x in stats),
                                   "cpu_pct": sum(x["cpu_pct"] for x in stats), "restarts": restarts, "health_failures": unhealthy, "api_failures": 0}
            for session in sessions:
                if session:
                    row["api_failures"] += exercise_api(base, session, headers, context)
                else:
                    row["api_failures"] += 1
            if running < SERVICES:
                row["api_failures"] += 1
            samples.append(row); stream.write(json.dumps(row) + "\n"); stream.flush()
            if not _STOP:
                time.sleep(max(1, args.interval_seconds))
    summary = summarize(samples, args.memory_cap_mib, args.growth_cap_mib)
    print(json.dumps(summary, sort_keys=True))
    return 0 if summary["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
