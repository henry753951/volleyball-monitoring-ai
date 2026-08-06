// Phase 1: claim OutboxEvent rows with SKIP LOCKED, publish durable pg-boss jobs, then mark PUBLISHED idempotently.
