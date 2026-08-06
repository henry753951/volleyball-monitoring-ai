# volleyball-monitoring-ai-sdk

External AI integration package. It validates the fixed Job/Result contracts, downloads and verifies the canonical clip, checks `VOV1` overlay envelopes, and sends idempotent callbacks. It does not contain AI models.

```bash
pip install "volleyball-monitoring-ai-sdk @ git+https://github.com/<OWNER>/volleyball-monitoring-ai.git@v0.1.0#subdirectory=sdk"
```

```python
from volleyball_monitoring_ai import AIJobRequest, CallbackClient, validate_passthrough

job = AIJobRequest.model_validate_json(request_body)
result = run_existing_ai_work(job)
validate_passthrough(job, result)
await CallbackClient(job).completed(result, overlay_bytes)
```

The human `marker_kind=service` is only the Z-key time anchor; it is not an action-model label and has no confidence. Action labels, confidence and group phase are optional provider extensions until the AI team supplies a real taxonomy and use case.

## Token boundary

`clip.download_url` is a short-lived signed URL and is fetched without the callback bearer token. `callback.token` is used only in `Authorization: Bearer ...` when POSTing progress/failure/completed callbacks to the central system.
