# Fake AI provider

This is an integration harness only. It validates the same SDK/job/callback path that a real
AI provider will use. It does not implement tracking, court projection, ball association or
action recognition.

Run from repository root:

```bash
uv sync --project sdk --frozen --extra provider --extra test
uv run --project sdk --frozen uvicorn examples.fake_ai_provider.app:app --host 0.0.0.0 --port 8080
```

The analyzer returns deterministic contract-valid no-model evidence for every immutable key point:
non-terminal events are `unresolved`, terminal events are `no_player`, positions/actions/confidence are
not fabricated, and the VOV1 overlay is a real empty FlatBuffer. It is an integration fixture, not an AI model.
