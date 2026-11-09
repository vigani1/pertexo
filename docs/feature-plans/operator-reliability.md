# Operator reliability and host sizing

Status: implemented and measured; final checks and full self-host drill verify the batch.

Batch J1 covers the supported single-server deployment. No new CI job or ECS
changes are in scope.

- Drain the worker before stopping the Code runner, including unhealthy-release
  shutdown.
- Use private storage transport while retaining the public origin for browser
  signatures. Verify readiness, reads, writes, and both signing paths without
  public DNS.
- Prepare PostgreSQL init scripts under stable operator state; changing release
  paths must not change its bind mount.
- Validate required and conditional settings with the application parsers before
  pulling release images, using the built operator checkout.
- Share the migrator's history/checksum compatibility rules with the pre-stop
  release gate, preserving baseline adoption and refusing incompatible fenced retries.
- Bound local release/image retention while preserving current/previous, running
  containers and every retained recovery point's release references.
- Qualify publishing/readiness with 4 GiB / 2 vCPU service cgroups, record Docker
  stats/OOM/probes, and set measured API/worker budgets. The runbook records the
  workload, allocation and limits of cgroup qualification. The worker RSS safety
  budget shares its container ceiling; its heap remains half that budget.
- Measure only: per-viewer authorization polling and terminal stream lifetime.
  Results are recorded in `docs/operations/workflow-run-stream-capacity.md`; the
  five-second authority lifetime and production stream behaviour are unchanged.

Verification requires red/green regressions for each fix, `pnpm check`, all
single-server unit tests, artifact-store unit/integration tests, and the full
proxy, stack, and quickstart self-host drill on isolated ports.
