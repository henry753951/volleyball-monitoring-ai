#!/usr/bin/env python3
import json
import os
import sys
import urllib.error
import urllib.request

HOOK_URL = 'http://worker-media-indexer:4100/internal/media-indexer/recording-complete'


def validate_path(path: str) -> str:
    encoded = path.encode('utf-8')
    if not path or len(encoded) > 4096 or '\x00' in path or '\r' in path or '\n' in path:
        raise ValueError('invalid recording path')
    return path


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1:
        return 2
    try:
        path = validate_path(args[0])
    except (UnicodeError, ValueError):
        return 2

    token = os.environ.get('MEDIA_INDEXER_HOOK_TOKEN', '')
    if len(token) < 32:
        return 2
    body = json.dumps({'path': path}, ensure_ascii=False, separators=(',', ':')).encode()
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
