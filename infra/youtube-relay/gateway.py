#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', re.I)
INGEST_PATH = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$')
YOUTUBE_HOSTS = {'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be'}
MAX_BODY_BYTES = 16_384


def required_env(name: str, minimum: int = 1) -> str:
    value = os.environ.get(name, '').strip()
    if len(value) < minimum:
        raise RuntimeError(f'{name} is required')
    return value


def safe_ingest_path(value: str) -> str:
    parts = value.split('/')
    if not INGEST_PATH.fullmatch(value) or any(part in ('', '.', '..') for part in parts):
        raise ValueError('invalid ingest path')
    return value


def safe_youtube_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme != 'https' or (parsed.hostname or '').lower() not in YOUTUBE_HOSTS or parsed.path in ('', '/'):
        raise ValueError('invalid YouTube URL')
    return value


def atomic_json(path: Path, value: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(value, separators=(',', ':')), encoding='utf-8')
    os.chmod(temporary, 0o600)
    temporary.replace(path)


@dataclass
class ManagedSource:
    config: dict[str, str]
    stop: threading.Event
    thread: threading.Thread
    process: subprocess.Popen[bytes] | None = None


class SourceManager:
    def __init__(self) -> None:
        self.recording_root = Path(required_env('MEDIA_RECORDING_ROOT')).resolve()
        self.import_root = Path(required_env('MEDIA_IMPORT_ROOT')).resolve()
        self.state_root = Path(required_env('MEDIA_SOURCE_STATE_ROOT')).resolve()
        self.work_root = Path(required_env('MEDIA_SOURCE_WORK_ROOT')).resolve()
        self.ingest_base = required_env('MEDIA_INGEST_BASE_URL').rstrip('/')
        self.format = os.environ.get(
            'YOUTUBE_FORMAT',
            'best[protocol*=m3u8][height=1080][fps>=59][fps<=61][vcodec^=avc][acodec!=none]/bestvideo[height=1080][fps>=59][fps<=61][vcodec^=avc]+bestaudio[acodec^=mp4a]',
        )
        self.extractor_args = os.environ.get('YOUTUBE_EXTRACTOR_ARGS', 'youtube:player_client=android_vr')
        self.callback_url = os.environ.get('MEDIA_SOURCE_CALLBACK_URL', '').strip()
        self.callback_token = os.environ.get('MEDIA_SOURCE_CALLBACK_TOKEN', '').strip()
        self.lock = threading.RLock()
        self.sources: dict[str, ManagedSource] = {}
        for directory in (self.recording_root, self.import_root, self.state_root, self.work_root):
            directory.mkdir(parents=True, exist_ok=True)

    def restore(self) -> None:
        for path in self.state_root.glob('*.json'):
            try:
                config = json.loads(path.read_text(encoding='utf-8'))
                if config.get('source_kind') == 'youtube':
                    self.start(config, persist=False)
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                path.unlink(missing_ok=True)

    def start(self, raw: dict[str, object], persist: bool = True) -> None:
        capture_id = str(raw.get('capture_session_id', ''))
        source_kind = str(raw.get('source_kind', ''))
        ingest_path = safe_ingest_path(str(raw.get('ingest_path', '')))
        if not UUID.fullmatch(capture_id) or source_kind not in ('youtube', 'local_mp4'):
            raise ValueError('invalid source request')
        config = {'capture_session_id': capture_id, 'source_kind': source_kind, 'ingest_path': ingest_path}
        if source_kind == 'youtube':
            config['source_url'] = safe_youtube_url(str(raw.get('source_url', '')))
        else:
            import_path = Path(str(raw.get('import_path', ''))).resolve()
            if import_path.suffix.lower() != '.mp4' or not import_path.is_relative_to(self.import_root) or not import_path.is_file():
                raise ValueError('invalid import path')
            config['import_path'] = str(import_path)
        with self.lock:
            if capture_id in self.sources:
                raise ValueError('capture source already exists')
            if persist:
                atomic_json(self.state_root / f'{capture_id}.json', config)
            stop = threading.Event()
            source = ManagedSource(config=config, stop=stop, thread=threading.Thread())
            source.thread = threading.Thread(target=self._run, args=(source,), name=f'media-source-{capture_id[:8]}', daemon=True)
            self.sources[capture_id] = source
            source.thread.start()

    def stop(self, capture_id: str) -> None:
        if not UUID.fullmatch(capture_id):
            raise ValueError('invalid capture id')
        with self.lock:
            source = self.sources.pop(capture_id, None)
            (self.state_root / f'{capture_id}.json').unlink(missing_ok=True)
        if not source:
            return
        source.stop.set()
        process = source.process
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()
        source.thread.join(timeout=10)

    def _run(self, source: ManagedSource) -> None:
        capture_id = source.config['capture_session_id']
        try:
            if source.config['source_kind'] == 'youtube':
                self._run_youtube(source)
            else:
                self._segment_file(source, Path(source.config['import_path']))
                (self.state_root / f'{capture_id}.json').unlink(missing_ok=True)
        except Exception as error:  # worker boundary: report a stable error, never the source URL
            if not source.stop.is_set():
                self._notify_failure(capture_id, type(error).__name__)
                (self.state_root / f'{capture_id}.json').unlink(missing_ok=True)
        finally:
            with self.lock:
                if self.sources.get(capture_id) is source:
                    self.sources.pop(capture_id, None)

    def _command(self, source: ManagedSource, args: list[str], capture: bool = False) -> subprocess.CompletedProcess[bytes]:
        if source.stop.is_set():
            raise RuntimeError('source stopped')
        process = subprocess.Popen(args, stdout=subprocess.PIPE if capture else None, stderr=subprocess.PIPE if capture else None)
        source.process = process
        stdout, stderr = process.communicate()
        source.process = None
        if process.returncode != 0:
            message = (stderr or b'')[-512:].decode(errors='replace')
            raise RuntimeError(f'command failed ({process.returncode}): {message}')
        return subprocess.CompletedProcess(args, process.returncode, stdout, stderr)

    def _run_youtube(self, source: ManagedSource) -> None:
        url = source.config['source_url']
        probe = self._command(source, [
            'yt-dlp', '--no-playlist', '--no-progress', '--no-warnings', '--skip-download',
            '--extractor-args', self.extractor_args, '--format', self.format, '--dump-single-json', url,
        ], capture=True)
        metadata = json.loads((probe.stdout or b'{}').decode())
        live = bool(metadata.get('is_live')) or metadata.get('live_status') in ('is_live', 'is_upcoming')
        if live:
            self._relay_live(source, url)
            return

        capture_id = source.config['capture_session_id']
        workspace = self.work_root / capture_id
        shutil.rmtree(workspace, ignore_errors=True)
        workspace.mkdir(parents=True)
        self._command(source, [
            'yt-dlp', '--no-playlist', '--no-progress', '--no-warnings',
            '--extractor-args', self.extractor_args, '--format', self.format,
            '--merge-output-format', 'mp4', '--output', str(workspace / 'source.%(ext)s'), url,
        ])
        candidates = sorted(workspace.glob('source.*'))
        if not candidates:
            raise RuntimeError('YouTube download did not produce a media file')
        self._segment_file(source, candidates[0])
        (self.state_root / f'{capture_id}.json').unlink(missing_ok=True)

    def _relay_live(self, source: ManagedSource, url: str) -> None:
        while not source.stop.is_set():
            resolved = self._command(source, [
                'yt-dlp', '--no-playlist', '--no-progress', '--no-warnings',
                '--extractor-args', self.extractor_args, '--format', self.format, '--get-url', url,
            ], capture=True)
            stream_urls = [line for line in (resolved.stdout or b'').decode().splitlines() if line]
            if len(stream_urls) not in (1, 2):
                raise RuntimeError('expected one combined stream or separate video and audio streams')
            args = ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'warning']
            for stream_url in stream_urls:
                args.extend(['-re', '-i', stream_url])
            if len(stream_urls) == 1:
                args.extend(['-map', '0:v:0', '-map', '0:a:0?'])
            else:
                args.extend(['-map', '0:v:0', '-map', '1:a:0'])
            args.extend(['-c', 'copy', '-flvflags', 'no_duration_filesize', '-f', 'flv', f"{self.ingest_base}/{source.config['ingest_path']}"])
            process = subprocess.Popen(args)
            source.process = process
            return_code = process.wait()
            source.process = None
            if source.stop.is_set():
                return
            if return_code == 0:
                time.sleep(1)
            else:
                time.sleep(3)

    def _segment_file(self, source: ManagedSource, media_path: Path) -> None:
        capture_id = source.config['capture_session_id']
        workspace = self.work_root / capture_id
        segment_root = workspace / 'segments'
        shutil.rmtree(segment_root, ignore_errors=True)
        segment_root.mkdir(parents=True)
        probe = self._command(source, [
            'ffprobe', '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=codec_name', '-of', 'json', str(media_path),
        ], capture=True)
        streams = json.loads((probe.stdout or b'{}').decode()).get('streams', [])
        codec = streams[0].get('codec_name') if streams else None
        video_codec = ['-c:v', 'copy'] if codec == 'h264' else ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p']
        self._command(source, [
            'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'warning', '-i', str(media_path),
            '-map', '0:v:0', '-map', '0:a:0?', *video_codec, '-c:a', 'aac',
            '-f', 'segment', '-segment_time', '2', '-reset_timestamps', '1',
            '-segment_format', 'mp4', str(segment_root / 'segment-%09d.mp4'),
        ])
        segments = sorted(segment_root.glob('segment-*.mp4'))
        if not segments:
            raise RuntimeError('media segmentation did not produce output')
        destination = self.recording_root.joinpath(*source.config['ingest_path'].split('/'))
        destination.mkdir(parents=True, exist_ok=True)
        base = datetime.now(timezone.utc)
        for index, segment in enumerate(segments):
            if source.stop.is_set():
                return
            timestamp = base + timedelta(seconds=index * 2)
            name = f"{timestamp.strftime('%Y-%m-%d_%H-%M-%S')}-{timestamp.microsecond:06d}.mp4"
            temporary = destination / f'.{name}.part'
            shutil.copyfile(segment, temporary)
            temporary.replace(destination / name)
        shutil.rmtree(workspace, ignore_errors=True)
        if media_path.is_relative_to(self.import_root):
            shutil.rmtree(media_path.parent, ignore_errors=True)

    def _notify_failure(self, capture_id: str, error_code: str) -> None:
        if not self.callback_url or len(self.callback_token) < 32:
            return
        body = json.dumps({'capture_session_id': capture_id, 'error_code': error_code, 'status': 'failed'}, separators=(',', ':')).encode()
        request = urllib.request.Request(self.callback_url, data=body, method='POST', headers={
            'Authorization': f'Bearer {self.callback_token}', 'Content-Type': 'application/json',
        })
        try:
            urllib.request.urlopen(request, timeout=5).close()
        except (OSError, TimeoutError, urllib.error.HTTPError, urllib.error.URLError):
            pass


class Handler(BaseHTTPRequestHandler):
    manager: SourceManager
    token: str

    def log_message(self, message: str, *args: object) -> None:
        print(f'media-source-gateway: {message % args}', flush=True)

    def _authorized(self) -> bool:
        authorization = self.headers.get('Authorization', '')
        return hmac.compare_digest(authorization, f'Bearer {self.token}')

    def _json(self, status: int, value: dict[str, object]) -> None:
        body = json.dumps(value, separators=(',', ':')).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == '/health/ready':
            self._json(200, {'status': 'ready'})
            return
        self._json(404, {'code': 'NOT_FOUND'})

    def do_POST(self) -> None:
        if self.path != '/v1/sources' or not self._authorized():
            self._json(401 if not self._authorized() else 404, {'code': 'UNAUTHENTICATED' if not self._authorized() else 'NOT_FOUND'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length < 2 or length > MAX_BODY_BYTES:
                raise ValueError('invalid body size')
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError('invalid body')
            self.manager.start(body)
            self._json(202, {'status': 'starting'})
        except (ValueError, OSError, json.JSONDecodeError) as error:
            self._json(400, {'code': 'BAD_USER_INPUT', 'message': str(error)})

    def do_DELETE(self) -> None:
        prefix = '/v1/sources/'
        if not self._authorized():
            self._json(401, {'code': 'UNAUTHENTICATED'})
            return
        if not self.path.startswith(prefix):
            self._json(404, {'code': 'NOT_FOUND'})
            return
        try:
            self.manager.stop(self.path[len(prefix):])
            self._json(200, {'status': 'stopped'})
        except ValueError as error:
            self._json(400, {'code': 'BAD_USER_INPUT', 'message': str(error)})


def main() -> None:
    token = required_env('MEDIA_SOURCE_GATEWAY_TOKEN', 32)
    manager = SourceManager()
    Handler.manager = manager
    Handler.token = token
    manager.restore()
    host = os.environ.get('MEDIA_SOURCE_GATEWAY_BIND', '0.0.0.0')
    port = int(os.environ.get('MEDIA_SOURCE_GATEWAY_PORT', '8090'))
    ThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == '__main__':
    main()
