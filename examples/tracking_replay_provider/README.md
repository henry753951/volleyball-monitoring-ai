# Contract Lab tracking replay provider

This development provider replays recorded Contract Lab output for one verified
reference clip. Player detections and tracking come from YOLOX, Deep-EIoU and
SAM-refined output. Canonical `court_pos` comes from the saved court pipeline and
is never clamped by this repository.

The saved tracker output contains 14 raw IDs because two short right-side
fragments overlap the twelve stable on-court tracks. Before callback, this
provider deterministically groups tracks by AI-projected court side, keeps the
six longest-lived identities per side and associates short fragments with the
nearest same-side slot. This is an explicit development identity consolidation,
not learned REID. Duplicate same-frame observations are suppressed, the raw ID
mapping remains in result metadata and roster/player assignment remains unknown
until an operator completes it in the workstation.

The handoff also contains human frame-by-frame ball annotations and deterministic
ball-path action heuristics. Those sources remain explicitly identified in the
result metadata; this provider does not represent them as model inference.

```powershell
$env:CONTRACT_LAB_HANDOFF_ROOT='H:\Repos\volleyball-ai-contract-lab\ai-team-handoff'
uv sync --project sdk --frozen --extra provider --extra test
uv run --project sdk --frozen uvicorn examples.tracking_replay_provider.app:app --host 0.0.0.0 --port 8080
```
