from __future__ import annotations

import json
import os
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from gateway import ManagedSource, SourceManager


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


if __name__ == '__main__':
    unittest.main()
