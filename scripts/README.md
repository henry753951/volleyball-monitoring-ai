# Phase 2A soak harness

Run a bounded Docker Desktop memory/service smoke without stopping Compose:

```powershell
uv run --project sdk --frozen python scripts/phase2a_soak.py --duration-seconds 60 --interval-seconds 10
```

JSONL output defaults to the OS temporary directory and contains only bounded numeric runtime samples. The harness never stops Compose and only uses an unverified TLS context for `127.0.0.1`.

For the real media/API chain, provide the two seeded capture-session IDs and run as the SDK project (no additional dependencies):

```powershell
$env:PHASE2A_D001_SESSION_ID = '...'
$env:PHASE2A_D003_SESSION_ID = '...'
uv run --project sdk --frozen python scripts/phase2a_soak.py --duration-seconds 60 --interval-seconds 10
```

Optional `PHASE2A_API_BASE` defaults to `https://127.0.0.1`; `PHASE2A_ARCHIVE_TARGET_US` defaults to `0`. The summary reports samples, maximum memory, growth, restarts, API failures, and failure causes. Any cap, restart, service-count, or API failure returns nonzero. Ctrl+C/SIGTERM stops sampling, cleans no containers, and still prints a summary.

Unit tests:

```powershell
uv run --project sdk --frozen python -m unittest discover -s scripts -p 'test_*.py'
```
