# Phase 2A soak harness

Run a bounded Docker Desktop memory/service smoke without stopping Compose:

```powershell
uv run --project sdk --frozen python scripts/phase2a_soak.py --duration-seconds 60 --interval-seconds 10
```

JSONL output defaults to the OS temporary directory and contains only bounded numeric runtime samples. The harness never stops Compose and only uses an unverified TLS context for `127.0.0.1`.

For the real media/API chain, the bounded d003 CaptureSession is the default. Override it only when needed:

```powershell
$env:PHASE2A_CAPTURE_SESSION_ID = '00000000-0000-4000-8000-00000000d003'
uv run --project sdk --frozen python scripts/phase2a_soak.py --duration-seconds 60 --interval-seconds 10
```

Optional `PHASE2A_API_BASE` defaults to `https://127.0.0.1`; archive target defaults to the live-window midpoint. The summary reports samples, maximum memory, growth, restarts, health failures, API failures, and failure causes. Any cap, restart, service-health, service-set, or API failure returns nonzero. Ctrl+C/SIGTERM stops sampling, cleans no containers, and still prints a summary.

Unit tests:

```powershell
uv run --project sdk --frozen python -m unittest discover -s scripts -p 'test_*.py'
```
