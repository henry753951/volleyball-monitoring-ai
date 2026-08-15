# Worker agent rules

Follow the root `AGENTS.md` and media/runtime ADRs first.

- Jobs are durable and idempotent. Preserve strict-FIFO ordering per capture without globally blocking independent captures.
- A quarantined or dead-lettered media segment is failure evidence, not successful READY coverage.
- Wait for stable finalized files before probing; retry bounded finalization races and fail closed after exhaustion.
- Persist heartbeats and durable segment progress before claiming an ingest or capture is healthy.
- Clip and analysis work must reference immutable submissions.
- Keep role entrypoints independently runnable and do not hide required managed token/environment setup.

Run worker lint, typecheck, focused queue/media tests, then root integration and Compose smoke checks.
