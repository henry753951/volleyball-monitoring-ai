# Contract agent rules

Follow the root `AGENTS.md` and this package's `README.md` first.

- Contract changes are public changes: require an ADR/version decision, fixtures, validators, server/SDK updates, and consumer migration.
- Keep 64-bit values as decimal strings on JSON/GraphQL wires.
- Do not add model-specific assumptions for optional action, confidence, group phase, or track identity.
- `court_pos` remains external-AI-owned canonical data and may be outside 0..1.
- GraphQL schema is generated from server Pothos code; do not hand-edit its snapshot.
- Update normal, edge, and malformed fixtures where applicable and run contract validation plus GraphQL operation checks.
