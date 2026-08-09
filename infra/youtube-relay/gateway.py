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
from decimal import Decimal, InvalidOperation
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


@dataclass(frozen=True)
class MediaInput:
    url: str
    headers: dict[str, str]


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
                if config.get('source_kind') in ('youtube', 'local_mp4'):
                    self.start(config, persist=False)
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                path.unlink(missing_ok=True)

    def start(self, raw: dict[str, object], persist: bool = True) -> None:
        capture_id = str(raw.get('capture_session_id', ''))
        source_kind = str(raw.get('source_kind', ''))
        ingest_path = safe_ingest_path(str(raw.get('ingest_path', '')))
        if not UUID.fullmatch(capture_id) or source_kind not in ('youtube', 'local_mp4'):
            raise ValueError('invalid source request')
        config = {
            'capture_session_id': capture_id,
            'source_kind': source_kind,
            'ingest_path': ingest_path,
            'segment_base': str(raw.get('segment_base') or datetime.now(timezone.utc).isoformat()),
        }
        for key in (
            'completion_expected_segments',
            'completion_source_duration_us',
            'completion_source_kind',
            'resolved_source_duration_us',
            'resolved_source_kind',
        ):
            value = raw.get(key)
            if value is not None:
                config[key] = str(value)
        if source_kind == 'youtube':
            config['source_url'] = safe_youtube_url(str(raw.get('source_url', '')))
        else:
            requested_import_path = Path(str(raw.get('import_path', '')))
            import_path = (
                requested_import_path.resolve()
                if requested_import_path.is_absolute()
                else (self.import_root / requested_import_path).resolve()
            )
            completion_pending = 'completion_expected_segments' in config
            if (
                import_path.suffix.lower() != '.mp4'
                or not import_path.is_relative_to(self.import_root)
                or not completion_pending and not import_path.is_file()
            ):
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
        source_kind = source.config.get('resolved_source_kind') or (
            'local_mp4' if source.config['source_kind'] == 'local_mp4' else 'youtube_live'
        )
        duration_value = source.config.get('resolved_source_duration_us')
        duration_us = int(duration_value) if duration_value else None
        count = self._wait_for_recording_quiescence(source, allow_stopped=True, allow_empty=True)
        self._queue_completion(source, source_kind, duration_us, count)
        self._deliver_completion(source)

    def _run(self, source: ManagedSource) -> None:
        capture_id = source.config['capture_session_id']
        try:
            if 'completion_expected_segments' in source.config:
                self._deliver_completion(source)
                return
            if source.config['source_kind'] == 'youtube':
                self._run_youtube(source)
            else:
                media_path = Path(source.config['import_path'])
                duration_us = self._probe_duration_us(source, media_path)
                self._record_classification(source, 'local_mp4', duration_us)
                self._notify_classified(capture_id, 'local_mp4', duration_us)
                count = self._segment_file(source, media_path)
                if source.stop.is_set():
                    return
                self._queue_completion(source, 'local_mp4', duration_us, count)
                self._deliver_completion(source)
        except Exception as error:  # worker boundary: report a stable error, never the source URL
            if 'completion_expected_segments' in source.config:
                # Keep the durable completion receipt for restore/retry. Media
                # must not be re-segmented or relabeled failed after it exists.
                pass
            elif not source.stop.is_set():
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
        metadata = self._probe_youtube(source, url)
        duration_us = self._metadata_duration_us(metadata)
        live = self._metadata_is_live(metadata)
        was_live = metadata.get('live_status') == 'was_live'
        source_kind = 'youtube_live' if live else 'youtube_vod'
        capture_id = source.config['capture_session_id']
        self._record_classification(source, source_kind, duration_us)
        self._notify_classified(capture_id, source_kind, duration_us)
        if live:
            final_metadata = self._relay_live(source, url, metadata)
            if final_metadata is None:
                return
            final_duration_us = self._metadata_duration_us(final_metadata) or duration_us
            count = self._wait_for_recording_quiescence(source)
            self._queue_completion(source, 'youtube_live', final_duration_us, count)
            self._deliver_completion(source)
            return

        media_inputs = self._youtube_inputs(metadata)
        count = self._segment_inputs(
            source,
            media_inputs,
            str(metadata.get('vcodec') or ''),
        )
        if source.stop.is_set():
            return
        self._queue_completion(
            source,
            'youtube_live' if was_live else 'youtube_vod',
            duration_us,
            count,
        )
        self._deliver_completion(source)

    def _probe_youtube(self, source: ManagedSource, url: str) -> dict[str, object]:
        probe = self._command(source, [
            'yt-dlp', '--no-playlist', '--no-progress', '--no-warnings', '--skip-download',
            '--extractor-args', self.extractor_args, '--format', self.format, '--dump-single-json', url,
        ], capture=True)
        metadata = json.loads((probe.stdout or b'{}').decode())
        if not isinstance(metadata, dict):
            raise RuntimeError('YouTube metadata is invalid')
        return metadata

    @staticmethod
    def _metadata_is_live(metadata: dict[str, object]) -> bool:
        return bool(metadata.get('is_live')) or metadata.get('live_status') in ('is_live', 'is_upcoming')

    @staticmethod
    def _metadata_duration_us(metadata: dict[str, object]) -> int | None:
        value = metadata.get('duration')
        if value is None:
            return None
        try:
            duration_us = int(Decimal(str(value)) * Decimal(1_000_000))
        except (InvalidOperation, ValueError, TypeError):
            return None
        return duration_us if duration_us > 0 else None

    @staticmethod
    def _youtube_inputs(metadata: dict[str, object]) -> list[MediaInput]:
        selected = metadata.get('requested_formats')
        candidates = selected if isinstance(selected, list) and selected else [metadata]
        media_inputs: list[MediaInput] = []
        for candidate in candidates:
            if not isinstance(candidate, dict):
                continue
            url = candidate.get('url')
            if not isinstance(url, str) or urlparse(url).scheme not in ('http', 'https'):
                continue
            raw_headers = candidate.get('http_headers')
            headers = {
                str(name): str(value)
                for name, value in raw_headers.items()
                if isinstance(name, str) and isinstance(value, str) and name and value
            } if isinstance(raw_headers, dict) else {}
            media_inputs.append(MediaInput(url=url, headers=headers))
        if len(media_inputs) not in (1, 2):
            raise RuntimeError('expected one combined stream or separate video and audio streams')
        return media_inputs

    @staticmethod
    def _ffmpeg_input_args(media_input: str | MediaInput, realtime: bool = False) -> list[str]:
        resolved = media_input if isinstance(media_input, MediaInput) else MediaInput(media_input, {})
        args: list[str] = []
        if resolved.headers:
            # YouTube's signed googlevideo URLs are tied to the HTTP request
            # profile returned by yt-dlp. ffmpeg's default Lavf user agent can
            # otherwise receive a 403 even while the signed URL is fresh.
            serialized_headers = ''.join(
                f'{name}: {value}\r\n'
                for name, value in resolved.headers.items()
            )
            args.extend(['-headers', serialized_headers])
        if realtime:
            args.append('-re')
        args.extend(['-i', resolved.url])
        return args

    def _relay_live(
        self,
        source: ManagedSource,
        url: str,
        initial_metadata: dict[str, object] | None = None,
    ) -> dict[str, object] | None:
        metadata = initial_metadata
        while not source.stop.is_set():
            try:
                metadata = metadata or self._probe_youtube(source, url)
                if not self._metadata_is_live(metadata):
                    return metadata
                media_inputs = self._youtube_inputs(metadata)
            except RuntimeError:
                if source.stop.is_set():
                    return None
                try:
                    metadata = self._probe_youtube(source, url)
                    if not self._metadata_is_live(metadata):
                        return metadata
                except RuntimeError:
                    pass
                time.sleep(3)
                continue
            args = ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'warning']
            for media_input in media_inputs:
                args.extend(self._ffmpeg_input_args(media_input, realtime=True))
            if len(media_inputs) == 1:
                args.extend(['-map', '0:v:0', '-map', '0:a:0?'])
            else:
                args.extend(['-map', '0:v:0', '-map', '1:a:0'])
            args.extend(['-c', 'copy', '-flvflags', 'no_duration_filesize', '-f', 'flv', f"{self.ingest_base}/{source.config['ingest_path']}"])
            process = subprocess.Popen(args)
            source.process = process
            return_code = process.wait()
            source.process = None
            if source.stop.is_set():
                return None
            try:
                metadata = self._probe_youtube(source, url)
                if not self._metadata_is_live(metadata):
                    return metadata
            except RuntimeError:
                metadata = None
            time.sleep(1 if return_code == 0 else 3)
        return None

    def _probe_duration_us(self, source: ManagedSource, media_path: Path) -> int | None:
        probe = self._command(source, [
            'ffprobe', '-v', 'error', '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1', str(media_path),
        ], capture=True)
        try:
            duration_us = int(Decimal((probe.stdout or b'0').decode().strip()) * Decimal(1_000_000))
        except (InvalidOperation, ValueError):
            return None
        return duration_us if duration_us > 0 else None

    def _segment_file(self, source: ManagedSource, media_path: Path) -> int:
        capture_id = source.config['capture_session_id']
        probe = self._command(source, [
            'ffprobe', '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=codec_name', '-of', 'json', str(media_path),
        ], capture=True)
        streams = json.loads((probe.stdout or b'{}').decode()).get('streams', [])
        codec = streams[0].get('codec_name') if streams else None
        return self._segment_inputs(source, [MediaInput(str(media_path), {})], str(codec or ''))

    def _segment_inputs(self, source: ManagedSource, inputs: list[str | MediaInput], codec: str) -> int:
        capture_id = source.config['capture_session_id']
        workspace = self.work_root / capture_id
        segment_root = workspace / 'segments'
        shutil.rmtree(segment_root, ignore_errors=True)
        segment_root.mkdir(parents=True)
        destination = self.recording_root.joinpath(*source.config['ingest_path'].split('/'))
        destination.mkdir(parents=True, exist_ok=True)
        try:
            base = datetime.fromisoformat(source.config['segment_base'])
            if base.tzinfo is None:
                base = base.replace(tzinfo=timezone.utc)
            else:
                base = base.astimezone(timezone.utc)
        except (KeyError, ValueError):
            base = datetime.now(timezone.utc)
            source.config['segment_base'] = base.isoformat()
            self._persist(source)
        normalized_codec = codec.lower()
        video_codec = ['-c:v', 'copy'] if normalized_codec == 'h264' or normalized_codec.startswith('avc') else [
            '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
        ]
        args = ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'warning']
        for value in inputs:
            args.extend(self._ffmpeg_input_args(value))
        args.extend(['-map', '0:v:0', '-map', '0:a:0?' if len(inputs) == 1 else '1:a:0'])
        args.extend([
            *video_codec, '-c:a', 'aac', '-f', 'segment', '-segment_time', '2',
            # Each independently playable recording starts its own source PTS
            # epoch. The canonical planner joins those epochs in capture time;
            # the playback manifest emits a transport discontinuity at each
            # epoch boundary so MSE never overlaps the reset decode timestamps.
            '-reset_timestamps', '1', '-segment_format', 'mp4',
            # Emit independently playable fragmented MP4 files. The indexer
            # can split these into init/media artifacts directly instead of
            # launching a second ffmpeg remux for every DVR segment.
            '-segment_format_options',
            'movflags=+frag_keyframe+empty_moov+default_base_moof',
            str(segment_root / 'segment-%09d.mp4'),
        ])
        process = subprocess.Popen(args)
        source.process = process
        # Deterministic names plus an existing prefix make a gateway restart
        # resumable. Only files produced by this deterministic segment base
        # count toward that prefix: a capture may still contain legacy OME
        # recordings, and counting every MP4 would suppress new media until
        # ffmpeg happened to recreate the entire legacy file count.
        published = self._published_segment_prefix(destination, base)

        def publish(segment: Path, index: int) -> None:
            name = self._segment_filename(base, index)
            target = destination / name
            if target.is_file() and target.stat().st_size > 0:
                return
            temporary = destination / f'.{name}.part'
            shutil.copyfile(segment, temporary)
            temporary.replace(target)

        while True:
            return_code = process.poll()
            segments = sorted(segment_root.glob('segment-*.mp4'))
            # The segment muxer only seals the current tail when ffmpeg exits
            # successfully. A user stop terminates ffmpeg and can leave that
            # final path present but without a complete moov/moof layout. Keep
            # it withheld from both the spool and completion watermark.
            publishable = len(segments) if return_code == 0 else max(0, len(segments) - 1)
            while published < publishable:
                publish(segments[published], published)
                published += 1
            if return_code is not None:
                break
            if source.stop.is_set():
                process.terminate()
            time.sleep(0.1)
        source.process = None
        if source.stop.is_set():
            shutil.rmtree(workspace, ignore_errors=True)
            return published
        if return_code != 0:
            raise RuntimeError(f'media segmentation failed ({return_code})')
        if published == 0:
            raise RuntimeError('media segmentation did not produce output')
        shutil.rmtree(workspace, ignore_errors=True)
        return published

    @staticmethod
    def _segment_filename(base: datetime, index: int) -> str:
        timestamp = base + timedelta(seconds=index * 2)
        return f"{timestamp.strftime('%Y-%m-%d_%H-%M-%S')}-{timestamp.microsecond:06d}.mp4"

    @classmethod
    def _published_segment_prefix(cls, destination: Path, base: datetime) -> int:
        index = 0
        while True:
            path = destination / cls._segment_filename(base, index)
            try:
                if not path.is_file() or path.stat().st_size <= 0:
                    return index
            except OSError:
                return index
            index += 1

    def _wait_for_recording_quiescence(
        self,
        source: ManagedSource,
        allow_stopped: bool = False,
        allow_empty: bool = False,
    ) -> int:
        destination = self.recording_root.joinpath(*source.config['ingest_path'].split('/'))
        previous: tuple[tuple[str, int], ...] | None = None
        stable_polls = 0
        deadline = time.monotonic() + 30
        while (allow_stopped or not source.stop.is_set()) and time.monotonic() < deadline:
            current = tuple(
                (path.name, path.stat().st_size)
                for path in sorted(destination.glob('*.mp4'))
                if path.is_file() and path.stat().st_size > 0
            )
            stable_polls = stable_polls + 1 if (current or allow_empty) and current == previous else 0
            if stable_polls >= 3:
                return len(current)
            previous = current
            time.sleep(1)
        if source.stop.is_set() and not allow_stopped:
            return 0
        raise RuntimeError('live recording did not finalize')

    def _persist(self, source: ManagedSource) -> None:
        atomic_json(
            self.state_root / f"{source.config['capture_session_id']}.json",
            source.config,
        )

    def _record_classification(
        self,
        source: ManagedSource,
        source_kind: str,
        duration_us: int | None,
    ) -> None:
        source.config['resolved_source_kind'] = source_kind
        if duration_us is not None:
            source.config['resolved_source_duration_us'] = str(duration_us)
        self._persist(source)

    def _queue_completion(
        self,
        source: ManagedSource,
        source_kind: str,
        duration_us: int | None,
        expected_segment_count: int,
    ) -> None:
        source.config['completion_expected_segments'] = str(expected_segment_count)
        source.config['completion_source_kind'] = source_kind
        source.config['completion_source_duration_us'] = str(duration_us) if duration_us is not None else ''
        self._persist(source)

    def _deliver_completion(self, source: ManagedSource) -> None:
        capture_id = source.config['capture_session_id']
        duration_value = source.config.get('completion_source_duration_us', '')
        self._notify_completed(
            capture_id,
            source.config['completion_source_kind'],
            int(duration_value) if duration_value else None,
            int(source.config['completion_expected_segments']),
        )
        if source.config['source_kind'] == 'local_mp4':
            media_path = Path(source.config['import_path'])
            if media_path.is_relative_to(self.import_root):
                shutil.rmtree(media_path.parent, ignore_errors=True)
        (self.state_root / f'{capture_id}.json').unlink(missing_ok=True)

    def _notify_classified(self, capture_id: str, source_kind: str, duration_us: int | None) -> None:
        try:
            self._notify_status({
                'capture_session_id': capture_id,
                'source_duration_us': str(duration_us) if duration_us is not None else None,
                'source_kind': source_kind,
                'status': 'classified',
            })
        except RuntimeError:
            # Completion carries the same metadata and is durably retried.
            pass

    def _notify_completed(
        self,
        capture_id: str,
        source_kind: str,
        duration_us: int | None,
        expected_segment_count: int,
    ) -> None:
        self._notify_status({
            'capture_session_id': capture_id,
            'expected_segment_count': expected_segment_count,
            'source_duration_us': str(duration_us) if duration_us is not None else None,
            'source_kind': source_kind,
            'status': 'completed',
        })

    def _notify_status(self, payload: dict[str, object]) -> None:
        if not self.callback_url or len(self.callback_token) < 32:
            raise RuntimeError('media source callback is unavailable')
        body = json.dumps(payload, separators=(',', ':')).encode()
        for attempt in range(8):
            request = urllib.request.Request(self.callback_url, data=body, method='POST', headers={
                'Authorization': f'Bearer {self.callback_token}', 'Content-Type': 'application/json',
            })
            try:
                urllib.request.urlopen(request, timeout=5).close()
                return
            except (OSError, TimeoutError, urllib.error.HTTPError, urllib.error.URLError):
                if attempt < 7:
                    time.sleep(min(8, 2 ** attempt))
        raise RuntimeError('media source callback failed')

    def _notify_failure(self, capture_id: str, error_code: str) -> None:
        if not self.callback_url or len(self.callback_token) < 32:
            return
        try:
            self._notify_status({
                'capture_session_id': capture_id,
                'error_code': error_code,
                'status': 'failed',
            })
        except RuntimeError:
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
        except RuntimeError:
            self._json(503, {'code': 'SOURCE_COMPLETION_PENDING'})


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
