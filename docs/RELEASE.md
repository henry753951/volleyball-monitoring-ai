# Release process

The repository uses Conventional Commits and Release Please with a root simple package. Tags do not include a component name (`vX.Y.Z`).

## Version selection

- `fix:` produces a patch release unless a larger pending change exists.
- `feat:` produces a minor release.
- `!` or `BREAKING CHANGE:` requires a major version and an explicit migration decision.
- Documentation/tooling-only commits do not force a release unless intentionally configured otherwise.

## Integration gate

Before publishing:

1. Fetch/prune and inspect every worktree and branch.
2. Verify unique commits with `git rev-list --left-right --count main...<branch>` and ancestry with `git merge-base --is-ancestor`.
3. Preserve dirty work before merging or formatting.
4. Run:

```powershell
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
bun run validate:all
bun run graphql:schema:check
bun run db:validate
bun run checksums:refresh
git diff --check
```

5. Commit checksum changes separately when they only refresh generated integrity metadata.

## GitHub flow

1. Push a `codex/*` integration branch.
2. Open a pull request to `main` with scope, root cause, impact, and exact checks.
3. Merge only after required checks pass.
4. Release Please updates `CHANGELOG.md`, `.release-please-manifest.json`, and release metadata in its release PR.
5. Review and merge the Release Please PR.
6. Verify the resulting tag and GitHub Release, then confirm `main`, the tag, and published release point at the expected commits.

Do not hand-edit the manifest or tag around Release Please unless repairing a documented release-state mismatch. Do not claim a release from a successful source PR alone; the tag and GitHub Release must exist.
