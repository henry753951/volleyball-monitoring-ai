# ADR 0016: Outbound AI provider agent and processing cancellation

Status: Accepted
Date: 2026-08-08

## Context

External AI often runs on an operator's personal GPU computer behind NAT. Requiring that computer
to host `/v1/jobs` creates firewall, TLS and discovery work that is unrelated to inference. The
central system must also stop already-dispatched work when an annotator deletes a processing rally.

## Decision

- Add **AI Provider Realtime 1.0.0** as an outbound WebSocket control plane at
  `/api/v1/ai/providers/ws?integration_id=...`.
- Keep media and full results off WebSocket. A job contains a short-lived signed HTTPS clip URL;
  completion continues to use the bounded multipart callback 1.0 endpoint.
- Persist provider instances, delivery IDs, leases and cancellation acknowledgement. A reconnecting
  SDK advertises its active deliveries and the server answers with resume, abort or discard.
- Rotate the callback bearer token for each WebSocket delivery. It is never sent to object storage.
- Keep the HTTP-push provider adapter as `AiTransportMode.HTTP_PUSH`; new personal-computer agents
  use `WS_AGENT` and need no hosted API server.
- Deleting a processing rally is a serializable domain mutation. It creates an immutable
  cancellation submission, supersedes (but never deletes) the original submission, records a score
  correction when required, soft-voids the rally, cancels ClipJob/AiJob and writes an abort outbox
  event. Completed rallies cannot use this mutation.
- Callback completion, clip finalization and cancellation lock the same job rows before their final
  state transition. Late callbacks are rejected and cannot resurrect cancelled work.

## Consequences

AI computers only require outbound WSS/HTTPS connectivity. The control plane is small and
reconnectable, while the existing signed-media and callback boundaries remain unchanged. Central
deployments must configure a provider integration, a provider token and a callback URL reachable by
the AI computer.
