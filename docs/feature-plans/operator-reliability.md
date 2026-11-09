# Operator reliability and host sizing

Batch J1 covers the supported single-server deployment. No new CI job or ECS
changes are in scope.

- Drain the worker before stopping the Code runner, including unhealthy-release
  shutdown.
- Use private storage transport while retaining the public origin for browser
  signatures. Verify readiness, reads, writes, and both signing paths without
  public DNS.
- Prepare PostgreSQL init scripts under stable operator state; changing release
  paths must not change its bind mount.
- Report missing Compose settings before pulling release images. Conditional
  application configuration still needs full validation before pulls.
- Share the migrator's history/checksum compatibility rules with the pre-stop
  release gate, preserving baseline adoption and refusing incompatible fenced retries.
- Pending: bound local release/image retention while preserving rollback and
  every retained recovery point's release references.
- Pending: measure API/worker memory under load, set container budgets, and qualify
  publishing/readiness on the smallest supported host. Current host sizing in the
  runbook remains an estimate until qualification.
- Measure only: per-viewer authorization polling and terminal stream lifetime.
  Preserve revocation latency.

Verification requires red/green regressions for each fix, `pnpm check`, all
single-server unit tests, artifact-store unit/integration tests, and the full
proxy, stack, and quickstart self-host drill on isolated ports.
