import signal
import unittest

import phase2a_soak
from phase2a_soak import install_signal_handlers, parse_manifest, parse_memory, parse_stats, summarize


class SoakHelpersTest(unittest.TestCase):
    def test_stats_units_and_header(self):
        text = "NAME\tCPU %\tMEM USAGE / LIMIT\na\t2.5%\t128MiB / 1GiB\nb\t1%\t1GiB / 2GiB\n"
        self.assertEqual(parse_stats(text), [{"cpu_pct": 2.5, "mem_mib": 128}, {"cpu_pct": 1.0, "mem_mib": 1024}])
        self.assertAlmostEqual(parse_memory("512KiB"), 0.5)

    def test_manifest_strips_quotes_and_whitespace(self):
        self.assertEqual(parse_manifest('#EXTM3U\n #EXTINF:2,\n  "init.mp4" \n media.mp4\n'), ["init.mp4", "media.mp4"])

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


if __name__ == "__main__":
    unittest.main()
