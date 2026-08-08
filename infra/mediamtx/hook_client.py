#!/usr/bin/env python3
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HOOK_URL = 'http://worker-media-indexer:4100/internal/media-indexer/recording-complete'
EVENTS = {'recording_complete', 'source_online', 'source_offline'}


def validate_path(path: str) -> str:
    encoded = path.encode('utf-8')
    if not path or len(encoded) > 4096 or '\x00' in path or '\r' in path or '\n' in path:
        raise ValueError('invalid recording path')
    return path


def validate_ingest_path(path: str) -> str:
    validate_path(path)
    parts = path.split('/')
    if path.startswith('/') or '\\' in path or any(part in ('', '.', '..') for part in parts):
        raise ValueError('invalid ingest path')
    return path


def write_restart_marker(ingest_path: str) -> None:
    root = Path(os.environ.get('MEDIA_RECORDING_ROOT', '/recordings'))
    directory = root.joinpath(*validate_ingest_path(ingest_path).split('/'))
    directory.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime('%Y-%m-%d_%H-%M-%S-%f')
    marker = directory / f'.source-restart-{timestamp}.marker'
    marker.write_text(json.dumps({'event': 'source_offline'}, separators=(',', ':')), encoding='utf-8')


def payload_from_args(args: list[str]) -> dict[str, str]:
    # Keep the original one-argument form for older MediaMTX configurations.
    if len(args) == 1:
        return {'event': 'recording_complete', 'path': validate_path(args[0])}
    if len(args) != 2 or args[0] not in EVENTS:
        raise ValueError('invalid hook arguments')
    event = args[0]
    value = validate_path(args[1]) if event == 'recording_complete' else validate_ingest_path(args[1])
    return ({'event': event, 'path': value} if event == 'recording_complete'
            else {'event': event, 'ingest_path': value})


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    try:
        payload = payload_from_args(args)
    except (UnicodeError, ValueError):
        return 2

    if payload['event'] == 'source_offline':
        try:
            write_restart_marker(payload['ingest_path'])
        except OSError:
            return 1

    token = os.environ.get('MEDIA_INDEXER_HOOK_TOKEN', '')
    if len(token) < 32:
        return 2
    body = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode()
    if len(body) > 8192:
        return 2

    request = urllib.request.Request(
        os.environ.get('MEDIA_INDEXER_HOOK_URL', HOOK_URL),
        data=body,
        headers={
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json',
        },
        method='POST',
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return 0 if 200 <= response.status < 300 else 1
    except (OSError, TimeoutError, urllib.error.HTTPError, urllib.error.URLError):
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
