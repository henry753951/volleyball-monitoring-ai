#!/usr/bin/env python3
from __future__ import annotations

import base64
import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

RECORDING_ROOT = Path(os.environ.get('MEDIA_RECORDING_ROOT', '/recordings')).resolve()
STATE_PATH = Path(os.environ.get('OME_WATCHER_STATE_PATH', '/state/watcher.json')).resolve()
OME_API_URL = os.environ.get('OME_API_URL', 'http://ovenmediaengine:8081').rstrip('/')
OME_API_TOKEN = os.environ.get('OME_API_ACCESS_TOKEN', '')
HOOK_URL = os.environ.get('MEDIA_INDEXER_HOOK_URL', 'http://worker-media-indexer:4100/internal/media-indexer/recording-complete')
HOOK_TOKEN = os.environ.get('MEDIA_INDEXER_HOOK_TOKEN', '')


def request_json(url: str, authorization: str) -> object:
    request = urllib.request.Request(url, headers={'Authorization': authorization})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)


def post_hook(payload: dict[str, str]) -> None:
    body = json.dumps(payload, separators=(',', ':')).encode()
    request = urllib.request.Request(HOOK_URL, data=body, method='POST', headers={
        'Authorization': f'Bearer {HOOK_TOKEN}', 'Content-Type': 'application/json',
    })
    with urllib.request.urlopen(request, timeout=5) as response:
        if not 200 <= response.status < 300:
            raise RuntimeError(f'indexer hook returned {response.status}')


def restart_marker(stream: str) -> None:
    directory = RECORDING_ROOT / stream
    directory.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime('%Y-%m-%d_%H-%M-%S-%f')
    (directory / f'.source-restart-{timestamp}.marker').write_text('{"event":"source_offline"}', encoding='utf-8')


def load_state() -> tuple[set[str], set[str]]:
    try:
        value = json.loads(STATE_PATH.read_text(encoding='utf-8'))
        return set(value.get('completed', [])), set(value.get('streams', []))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return set(), set()


def save_state(completed: set[str], streams: set[str]) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = STATE_PATH.with_suffix('.tmp')
    temporary.write_text(json.dumps({'completed': sorted(completed), 'streams': sorted(streams)}, separators=(',', ':')), encoding='utf-8')
    temporary.replace(STATE_PATH)


def stream_names() -> set[str]:
    token = base64.b64encode(OME_API_TOKEN.encode()).decode()
    value = request_json(f'{OME_API_URL}/v1/vhosts/default/apps/app/streams', f'Basic {token}')
    response = value.get('response', []) if isinstance(value, dict) else []
    return {str(item) for item in response if isinstance(item, str) and item and '/' not in item and '\\' not in item}


def main() -> None:
    if len(OME_API_TOKEN) < 32 or len(HOOK_TOKEN) < 32:
        raise RuntimeError('OME and media indexer tokens are required')
    RECORDING_ROOT.mkdir(parents=True, exist_ok=True)
    completed, previous_streams = load_state()
    observations: dict[str, tuple[int, int]] = {}
    while True:
        changed = False
        try:
            current_streams = stream_names()
            for stream in current_streams - previous_streams:
                post_hook({'event': 'source_online', 'ingest_path': stream})
            for stream in previous_streams - current_streams:
                restart_marker(stream)
                post_hook({'event': 'source_offline', 'ingest_path': stream})
            if current_streams != previous_streams:
                previous_streams = current_streams
                changed = True
        except (OSError, TimeoutError, urllib.error.HTTPError, urllib.error.URLError, ValueError):
            pass

        for path in RECORDING_ROOT.rglob('*.mp4'):
            try:
                relative = path.resolve().relative_to(RECORDING_ROOT).as_posix()
                if relative in completed or relative.startswith('.'):
                    continue
                metadata = path.stat()
                prior_size, stable_count = observations.get(relative, (-1, 0))
                stable_count = stable_count + 1 if prior_size == metadata.st_size and time.time() - metadata.st_mtime >= 2 else 0
                observations[relative] = (metadata.st_size, stable_count)
                if metadata.st_size > 0 and stable_count >= 2:
                    post_hook({'event': 'recording_complete', 'path': str(path)})
                    completed.add(relative)
                    observations.pop(relative, None)
                    changed = True
            except (OSError, TimeoutError, urllib.error.HTTPError, urllib.error.URLError, ValueError):
                continue
        if changed:
            save_state(completed, previous_streams)
        time.sleep(1)


if __name__ == '__main__':
    main()
