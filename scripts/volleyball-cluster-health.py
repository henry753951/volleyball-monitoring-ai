#!/usr/bin/env python3
"""Small dependency-free health monitor for the volleyball k3s namespace.

Examples:
  python3 volleyball-cluster-health.py
  python3 volleyball-cluster-health.py --watch 10
  python3 volleyball-cluster-health.py --namespace volleyball-monitoring --errors

The script only reads Kubernetes state. It does not restart pods or mutate the
cluster. Exit code is non-zero when a node/pod/deployment is unhealthy.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import time
from datetime import UTC, datetime
from typing import Any

DEFAULT_NAMESPACE = "volleyball-monitoring"
ERROR_PATTERN = re.compile(
    r"\b(error|fatal|panic|traceback|exception|oomkilled|crashloopbackoff)\b",
    re.IGNORECASE,
)
URL_QUERY_PATTERN = re.compile(r"https?://[^\s\"']+")
SECRET_QUERY_PATTERN = re.compile(
    r"(?i)(authorization|cookie|token|password|secret|signature|sig|key)=([^\s,;\"'}]+)"
)


def kubectl(namespace: str | None, *args: str) -> Any:
    command = ["kubectl"]
    if namespace:
        command.extend(["-n", namespace])
    command.extend(args)
    completed = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise RuntimeError(f"{' '.join(command)}: {detail}")
    if "-o" in args and "json" in args:
        return json.loads(completed.stdout or "{}")
    return completed.stdout


def age(timestamp: str | None) -> str:
    if not timestamp:
        return "-"
    try:
        created = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        seconds = max(0, int((datetime.now(UTC) - created).total_seconds()))
    except ValueError:
        return "?"
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m"
    if seconds < 86400:
        return f"{seconds // 3600}h"
    return f"{seconds // 86400}d"


def ready_condition(conditions: list[dict[str, Any]], condition_type: str) -> bool:
    return any(
        condition.get("type") == condition_type and condition.get("status") == "True"
        for condition in conditions
    )


def safe_log_line(line: str) -> str:
    def redact_url(match: re.Match[str]) -> str:
        value = match.group(0)
        return value.split("?", 1)[0] + ("?<redacted>" if "?" in value else "")

    line = URL_QUERY_PATTERN.sub(redact_url, line)
    return SECRET_QUERY_PATTERN.sub(r"\1=<redacted>", line)


def pod_state(pod: dict[str, Any]) -> tuple[bool, str, int, list[str]]:
    status = pod.get("status", {})
    phase = status.get("phase", "Unknown")
    containers = status.get("containerStatuses", [])
    init_containers = status.get("initContainerStatuses", [])
    all_statuses = init_containers + containers
    restarts = sum(int(item.get("restartCount", 0)) for item in all_statuses)
    reasons: list[str] = []
    for item in containers:
        state = item.get("state", {})
        waiting = state.get("waiting") or {}
        terminated = state.get("terminated") or {}
        if waiting.get("reason"):
            reasons.append(waiting["reason"])
        if terminated.get("reason"):
            reasons.append(terminated["reason"])
        if waiting.get("message") and waiting.get("reason") not in reasons:
            reasons.append(waiting["message"][:100])
    for item in init_containers:
        state = item.get("state", {})
        waiting = state.get("waiting") or {}
        terminated = state.get("terminated") or {}
        if waiting.get("reason"):
            reasons.append(f"init:{waiting['reason']}")
        if terminated and int(terminated.get("exitCode", 1)) != 0:
            reasons.append(f"init:{terminated.get('reason', 'failed')}")
    init_ok = all(
        bool(item.get("state", {}).get("terminated"))
        and int(item["state"]["terminated"].get("exitCode", 1)) == 0
        for item in init_containers
    )
    ready = (
        phase == "Running"
        and bool(containers)
        and all(item.get("ready") is True for item in containers)
        and init_ok
    ) or phase == "Succeeded"
    return ready, phase, restarts, reasons


def print_header(namespace: str) -> None:
    now = datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")
    print(f"Volleyball cluster health  {now}  namespace={namespace}")
    print("=" * 96)


def print_nodes() -> bool:
    data = kubectl(None, "get", "nodes", "-o", "json")
    nodes = data.get("items", [])
    if not nodes:
        print("NODE  FAIL  no nodes returned")
        return False
    healthy = True
    print("Nodes")
    for node in nodes:
        name = node.get("metadata", {}).get("name", "?")
        ready = ready_condition(node.get("status", {}).get("conditions", []), "Ready")
        healthy &= ready
        print(f"  {'OK  ' if ready else 'FAIL'} {name}")
    return healthy


def print_workloads(namespace: str) -> bool:
    healthy = True
    for kind in ("deployments", "statefulsets"):
        data = kubectl(namespace, "get", kind, "-o", "json")
        items = data.get("items", [])
        if not items:
            continue
        print(kind.capitalize())
        for item in items:
            metadata = item.get("metadata", {})
            status = item.get("status", {})
            name = metadata.get("name", "?")
            desired = int(status.get("replicas", 0))
            ready = int(status.get("readyReplicas", 0))
            updated = int(status.get("updatedReplicas", 0))
            is_ready = desired > 0 and ready == desired and updated == desired
            healthy &= is_ready
            print(
                f"  {'OK  ' if is_ready else 'FAIL'} {name:<28} "
                f"ready={ready}/{desired} updated={updated}/{desired}"
            )
    return healthy


def print_pods(namespace: str) -> tuple[bool, list[dict[str, Any]]]:
    data = kubectl(namespace, "get", "pods", "-o", "json")
    pods = data.get("items", [])
    healthy = True
    print("Pods")
    if not pods:
        print("  FAIL no pods returned")
        return False, []
    for pod in sorted(pods, key=lambda item: item.get("metadata", {}).get("name", "")):
        metadata = pod.get("metadata", {})
        name = metadata.get("name", "?")
        ready, phase, restarts, reasons = pod_state(pod)
        healthy &= ready
        suffix = ",".join(dict.fromkeys(reasons)) if reasons else "-"
        print(
            f"  {'OK  ' if ready else 'FAIL'} {name:<42} "
            f"phase={phase:<10} restarts={restarts:<3} age={age(metadata.get('creationTimestamp')):<4} "
            f"reason={suffix}"
        )
    return healthy, pods


def recent_errors(namespace: str, pods: list[dict[str, Any]]) -> int:
    found = 0
    print("Recent log error scan (last 5 minutes)")
    for pod in pods:
        name = pod.get("metadata", {}).get("name", "?")
        try:
            output = kubectl(
                namespace,
                "logs",
                name,
                "--all-containers=true",
                "--since=5m",
                "--tail=300",
            )
        except RuntimeError as exc:
            print(f"  WARN {name}: log scan skipped ({str(exc)[:160]})")
            continue
        matches = [line.strip() for line in output.splitlines() if ERROR_PATTERN.search(line)]
        if matches:
            found += len(matches)
            print(f"  WARN {name}: {len(matches)} matching lines")
            for line in matches[-3:]:
                # Keep output useful without dumping full logs or signed URLs.
                print(f"       {safe_log_line(line)[:240]}")
    if found == 0:
        print("  OK   no matching error lines")
    return found


def run_once(namespace: str, scan_errors: bool) -> int:
    try:
        print_header(namespace)
        node_ok = print_nodes()
        print()
        workload_ok = print_workloads(namespace)
        print()
        pod_ok, pods = print_pods(namespace)
        print()
        error_count = recent_errors(namespace, pods) if scan_errors else 0
        print()
        overall = node_ok and workload_ok and pod_ok and error_count == 0
        print(f"OVERALL: {'OK' if overall else 'CHECK REQUIRED'}")
        return 0 if overall else 1
    except (OSError, RuntimeError, json.JSONDecodeError) as exc:
        print(f"OVERALL: FAIL ({exc})", file=sys.stderr)
        return 2


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--namespace", default=DEFAULT_NAMESPACE)
    parser.add_argument("--watch", type=int, metavar="SECONDS", help="repeat until Ctrl-C")
    parser.add_argument("--errors", action="store_true", help="scan recent pod logs")
    args = parser.parse_args()

    if shutil.which("kubectl") is None:
        print("kubectl was not found in PATH", file=sys.stderr)
        return 2

    if not args.watch:
        return run_once(args.namespace, args.errors)

    try:
        while True:
            print("\033[2J\033[H", end="")
            run_once(args.namespace, args.errors)
            print(f"\nNext check in {args.watch}s. Press Ctrl-C to stop.")
            time.sleep(args.watch)
    except KeyboardInterrupt:
        print("\nStopped.")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
