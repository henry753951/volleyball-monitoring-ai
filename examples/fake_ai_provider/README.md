# Fake AI provider

This is an integration harness only. It validates the same SDK/job/callback path that a real
AI provider will use. It does not implement tracking, court projection, ball association or
action recognition.

Run from repository root:

```bash
uv sync --project sdk --frozen --extra provider --extra test
uv run --project sdk --frozen uvicorn examples.fake_ai_provider.app:app --host 0.0.0.0 --port 8080
```

The placeholder analyzer must be replaced by a fixture-backed response before end-to-end tests.
