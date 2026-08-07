# Contract Lab tracking replay provider

This development provider replays recorded Contract Lab output for one verified
reference clip. Player detections and tracking come from YOLOX, Deep-EIoU and
SAM-refined output. Canonical `court_pos` comes from the saved court pipeline and
is never clamped by this repository.

The handoff also contains human frame-by-frame ball annotations and deterministic
ball-path action heuristics. Those sources remain explicitly identified in the
result metadata; this provider does not represent them as model inference.

```powershell
$env:CONTRACT_LAB_HANDOFF_ROOT='H:\Repos\volleyball-ai-contract-lab\ai-team-handoff'
uv sync --project sdk --frozen --extra provider --extra test
uv run --project sdk --frozen uvicorn examples.tracking_replay_provider.app:app --host 0.0.0.0 --port 8080
```
