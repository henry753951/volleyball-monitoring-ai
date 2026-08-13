# volleyball-monitoring-ai-sdk

External AI worker SDK. The AI computer makes one outbound WebSocket connection to the central
server and therefore does **not** need to host a public API server. The WebSocket is only the
control plane (job offers, leases, progress, resume and abort). Canonical MP4 download and
AnalysisData callback remain bounded HTTPS transfers; binary analysis data never travels through WebSocket.

```bash
uv add "volleyball-monitoring-ai-sdk @ git+https://github.com/henry753951/volleyball-monitoring-ai.git@<COMMIT_SHA>#subdirectory=sdk"
```

Copy `sdk/examples/fixture_worker.py` into the AI project, then run:

```powershell
$env:VOLLEYBALL_AI_WS_URL = "wss://central.example.com/api/v1/ai/providers/ws"
$env:VOLLEYBALL_AI_TOKEN = "replace-with-provider-token"
uv run python fixture_worker.py
```

The example performs the complete lifecycle:

1. waits for a server `job_offer`;
2. downloads the signed canonical MP4 to `<workspace>/<ai_job_id>/canonical.mp4` through a
   checksum-verified `.part` file;
3. runs an abort-aware placeholder loop where the AI team connects its decoder and models;
4. adapts the bundled golden domain result into a typed `AnalysisDomainData` object;
5. sends exactly one `VAD1` AnalysisData FlatBuffer to the job's authenticated callback URL.

`abort_job` cancels an active download or handler and removes an incomplete `.part` file. On a
network interruption, the client reconnects with exponential backoff and advertises active jobs so
the server can answer with resume, abort or discard.

The endpoint is fixed. The bearer token identifies `volleyball-analysis-engine` and its credentials;
workers never need an internal integration UUID.

## Existing HTTP provider adapter

`create_provider_app` is available under the optional `provider` extra for local adapters. Normal
AI deployments use `AIWorkerClient`; they do not need FastAPI or an inbound port.

## Contract boundary

The SDK validates Job `3.0.0`, AnalysisData domain `1.0.0`, Provider Realtime `2.0.0` and callback
`2.0.0`. Z supplies only start/end boundaries; X supplies optional non-terminal contact hints.
Action labels, confidence and group phase remain optional AI-owned extensions. The signed
`clip.download_url` never receives the callback bearer token.

## Offline development mode

`OfflineRunner` executes an analyzer without constructing a WebSocket, downloader or callback
client. It validates the same `AIJobRequest`, optionally replaces `key_points` from a standalone
JSON file, verifies the local clip byte length and SHA-256, and writes `analysis-data.vad1` and
`offline-run.json` atomically.

```python
from pathlib import Path

from volleyball_monitoring_ai import OfflineRunner

result = await OfflineRunner().run(
    job_path=Path("ai-job.json"),
    key_points_path=Path("keypoints.json"),  # optional
    clip_path=Path("clip.mp4"),
    output_dir=Path("outputs/local-run"),
    analyzer=analyze,
)
```

The job keeps its immutable IDs and authoritative clip-local frame/time/PTS anchors. Offline mode
does not fetch `clip.download_url` and does not call the job callback.
