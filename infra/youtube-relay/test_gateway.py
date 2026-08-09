from __future__ import annotations

import json
import os
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from gateway import ManagedSource, MediaInput, SourceManager


class SourceManagerLifecycleTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.environment = patch.dict(os.environ, {
            'MEDIA_IMPORT_ROOT': str(root / 'imports'),
            'MEDIA_INGEST_BASE_URL': 'rtmp://ome:1935/app',
            'MEDIA_RECORDING_ROOT': str(root / 'recordings'),
            'MEDIA_SOURCE_STATE_ROOT': str(root / 'state'),
            'MEDIA_SOURCE_WORK_ROOT': str(root / 'work'),
        })
        self.environment.start()
        self.manager = SourceManager()

    def tearDown(self) -> None:
        self.environment.stop()
        self.temporary.cleanup()

    def source(self) -> ManagedSource:
        return ManagedSource(
            config={
                'capture_session_id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                'ingest_path': 'match/main',
                'segment_base': '2026-08-09T00:00:00+00:00',
                'source_kind': 'youtube',
                'source_url': 'https://www.youtube.com/watch?v=example',
            },
            stop=threading.Event(),
            thread=threading.Thread(),
        )

    def test_completion_receipt_is_persisted_before_callback(self) -> None:
        source = self.source()
        self.manager._record_classification(source, 'youtube_vod', 9_000_000)
        self.manager._queue_completion(source, 'youtube_vod', 9_000_000, 5)

        state_path = self.manager.state_root / 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json'
        state = json.loads(state_path.read_text(encoding='utf-8'))
        self.assertEqual(state['completion_expected_segments'], '5')
        self.assertEqual(state['completion_source_kind'], 'youtube_vod')

        with patch.object(self.manager, '_notify_completed') as notify:
            self.manager._deliver_completion(source)
        notify.assert_called_once_with(
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'youtube_vod',
            9_000_000,
            5,
        )
        self.assertFalse(state_path.exists())

    def test_youtube_terminal_metadata_is_not_treated_as_active_live(self) -> None:
        self.assertTrue(self.manager._metadata_is_live({'live_status': 'is_live'}))
        self.assertFalse(self.manager._metadata_is_live({'live_status': 'was_live'}))

    def test_youtube_selected_format_headers_are_forwarded_to_ffmpeg(self) -> None:
        inputs = self.manager._youtube_inputs({
            'requested_formats': [
                {
                    'url': 'https://video.example.test/stream',
                    'http_headers': {
                        'User-Agent': 'yt-dlp-browser-profile',
                        'Accept-Language': 'en-US',
                    },
                },
                {
                    'url': 'https://audio.example.test/stream',
                    'http_headers': {'User-Agent': 'yt-dlp-browser-profile'},
                },
            ],
        })

        self.assertEqual(len(inputs), 2)
        arguments = self.manager._ffmpeg_input_args(inputs[0], realtime=True)
        self.assertEqual(arguments[-2:], ['-i', 'https://video.example.test/stream'])
        self.assertIn('-re', arguments)
        serialized = arguments[arguments.index('-headers') + 1]
        self.assertIn('User-Agent: yt-dlp-browser-profile\r\n', serialized)
        self.assertIn('Accept-Language: en-US\r\n', serialized)

    def test_youtube_metadata_without_a_playable_url_is_rejected(self) -> None:
        with self.assertRaisesRegex(RuntimeError, 'expected one combined stream'):
            self.manager._youtube_inputs({'requested_formats': [{'format_id': '299'}]})

    def test_resume_prefix_ignores_legacy_recordings(self) -> None:
        destination = self.manager.recording_root / 'match' / 'main'
        destination.mkdir(parents=True)
        (destination / '20260808223309_1229.mp4').write_bytes(b'legacy')
        base = datetime(2026, 8, 9, tzinfo=timezone.utc)

        self.assertEqual(
            self.manager._published_segment_prefix(destination, base),
            0,
        )

        (destination / self.manager._segment_filename(base, 0)).write_bytes(b'first')
        (destination / self.manager._segment_filename(base, 1)).write_bytes(b'second')
        self.assertEqual(
            self.manager._published_segment_prefix(destination, base),
            2,
        )

    def test_local_import_key_is_resolved_beneath_shared_root(self) -> None:
        capture_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        media_path = self.manager.import_root / capture_id / 'source.mp4'
        media_path.parent.mkdir(parents=True, exist_ok=True)
        media_path.write_bytes(b'mp4')

        with patch('threading.Thread.start'):
            self.manager.start({
                'capture_session_id': capture_id,
                'import_path': f'{capture_id}/source.mp4',
                'ingest_path': 'match/local',
                'source_kind': 'local_mp4',
            })

        self.assertEqual(
            self.manager.sources[capture_id].config['import_path'],
            str(media_path.resolve()),
        )

    def test_local_import_key_cannot_escape_shared_root(self) -> None:
        outside = self.manager.import_root.parent / 'outside.mp4'
        outside.write_bytes(b'mp4')
        with self.assertRaisesRegex(ValueError, 'invalid import path'):
            self.manager.start({
                'capture_session_id': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                'import_path': '../outside.mp4',
                'ingest_path': 'match/local',
                'source_kind': 'local_mp4',
            })

    def test_segment_muxer_emits_fragmented_mp4_pts_epochs(self) -> None:
        source = self.source()
        media_path = self.manager.import_root / 'source.mp4'
        media_path.parent.mkdir(parents=True, exist_ok=True)
        media_path.write_bytes(b'mp4')

        class CompletedProcess:
            returncode = 0

            @staticmethod
            def poll() -> int:
                return 0

        with patch.object(self.manager, '_published_segment_prefix', return_value=1), \
                patch('subprocess.Popen', return_value=CompletedProcess()) as popen:
            self.assertEqual(
                self.manager._segment_inputs(source, [str(media_path)], 'h264'),
                1,
            )

        arguments = popen.call_args.args[0]
        self.assertEqual(
            arguments[arguments.index('-reset_timestamps') + 1],
            '1',
        )
        self.assertIn('movflags=+frag_keyframe+empty_moov+default_base_moof', arguments)

    def test_stopped_segment_muxer_withholds_unsealed_tail(self) -> None:
        source = self.source()
        source.stop.set()
        capture_id = source.config['capture_session_id']

        class StoppedProcess:
            returncode = 255

            @staticmethod
            def poll() -> int:
                return 255

        def popen(_arguments: list[str]) -> StoppedProcess:
            segment_root = self.manager.work_root / capture_id / 'segments'
            (segment_root / 'segment-000000000.mp4').write_bytes(b'sealed')
            (segment_root / 'segment-000000001.mp4').write_bytes(b'unsealed')
            return StoppedProcess()

        with patch('subprocess.Popen', side_effect=popen):
            self.assertEqual(
                self.manager._segment_inputs(source, ['source.mp4'], 'h264'),
                1,
            )

        destination = self.manager.recording_root / 'match' / 'main'
        self.assertEqual(
            [path.read_bytes() for path in destination.glob('*.mp4')],
            [b'sealed'],
        )


if __name__ == '__main__':
    unittest.main()
