# Python SDK agent rules

Follow the root `AGENTS.md` and contract package guidance first.

- The SDK implements provider transport, serialization, and fixtures, not AI models.
- Preserve wire compatibility with `packages/contracts`; update both sides and fixtures together.
- Keep worker startup/reconnect/revocation behavior explicit and bounded.
- Use `uv` with the checked-in lockfile. Run Ruff, pytest with the `test` extra, and package build checks before release.
- If the analysis engine consumes a changed local SDK, reinstall it in the engine environment before integration testing; source changes alone do not refresh an installed package.
