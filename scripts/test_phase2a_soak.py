import signal
import unittest

import argparse
import phase2a_soak
from phase2a_soak import install_signal_handlers, parse_manifest, parse_memory, parse_stats, summarize, restart_delta, validate_config, expected_error, validate_anchor, service_health_failures


class SoakHelpersTest(unittest.TestCase):
    def test_stats_units_and_header(self):
        text = "NAME\tCPU %\tMEM USAGE / LIMIT\na\t2.5%\t128MiB / 1GiB\nb\t1%\t1GiB / 2GiB\n"
        self.assertEqual(parse_stats(text), [{"cpu_pct": 2.5, "mem_mib": 128}, {"cpu_pct": 1.0, "mem_mib": 1024}])
        self.assertAlmostEqual(parse_memory("512KiB"), 0.5)

    def test_manifest_strips_quotes_and_whitespace(self):
        self.assertEqual(parse_manifest('#EXTM3U\n #EXTINF:2,\n  "init.mp4" \n media.mp4\n'), ["init.mp4", "media.mp4"])
        self.assertEqual(parse_manifest('#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\nmedia.mp4\n'), ["init.mp4", "media.mp4"])

    def test_thresholds_restarts_and_api_failures(self):
        result = summarize([{"memory_mib": 100, "restarts": 1, "api_failures": 2}], 200, 20)
        self.assertFalse(result["passed"])
        self.assertEqual(result["restarts"], 1)
        self.assertIn("container_restart", result["failures"])
        self.assertIn("api_failure", result["failures"])

    def test_empty_summary_fails(self):
        self.assertFalse(summarize([], 1, 1)["passed"])

    def test_signal_handler_sets_stop_and_exit_summary(self):
        phase2a_soak._STOP = False
        old = signal.getsignal(signal.SIGINT)
        try:
            install_signal_handlers()
            signal.getsignal(signal.SIGINT)(signal.SIGINT, None)
            self.assertTrue(phase2a_soak._STOP)
            self.assertEqual(summarize([{"memory_mib": 1}], 2, 2)["passed"], True)
        finally:
            signal.signal(signal.SIGINT, old)

    def test_restart_delta_and_config(self):
        self.assertEqual(restart_delta(3, 1), 2)
        self.assertEqual(restart_delta(1, 3), 0)
        args = argparse.Namespace(duration_seconds=1, interval_seconds=1, memory_cap_mib=1, growth_cap_mib=1)
        validate_config(args, "00000000-0000-4000-8000-00000000d003")
        with self.assertRaises(ValueError):
            validate_config(argparse.Namespace(duration_seconds=0, interval_seconds=1, memory_cap_mib=1, growth_cap_mib=1), "bad")

    def test_stopped_service_is_health_failure(self):
        self.assertEqual(service_health_failures({"worker": {"state": "exited", "health": "none"}}), 1)
        self.assertEqual(service_health_failures({"worker": {"state": "running", "health": "none"}}), 0)

    def test_anchor_and_boundary_validation(self):
        validate_anchor({"capture_session_id":"s", "mapping_version":1, "capture_time_us":"1", "capture_frame_index":"2", "resolved_player_media_time_us":"3", "source_pts":"-4"}, "s", 1)
        self.assertTrue(expected_error(409, b'{"code":"WINDOW_BOUNDARY"}', {409}, {"WINDOW_BOUNDARY"}))
        self.assertFalse(expected_error(200, b'{"code":"WINDOW_BOUNDARY"}', {409}, {"WINDOW_BOUNDARY"}))


if __name__ == "__main__":
    unittest.main()
