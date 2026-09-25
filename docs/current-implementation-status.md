# Current Backend Implementation Status

Updated: 2026-09-25

## Delivery state

The backend implementation through Phase 6 is complete. Phase 7 is **in
progress**: repository-local implementation and qualification are substantially
complete, but production deployment, provider, resilience, and operational
evidence still require the authorized external environments. The authoritative
phase checklist and evidence journal are in
[`implementation-progress.md`](./implementation-progress.md); the blueprint is
[`workflow-platform-backend-plan.md`](./workflow-platform-backend-plan.md).

The backend fixes are recorded in commit `f0484564`. The final SSE
public-projection follow-up preserves the original projection error, starts
bounded transport cleanup even when a nested iterator is uncooperative, and
observes late fulfillment or rejection without leaking listeners or timers.
The full API run passed 97 files / 1,277 tests.

The documentation and infrastructure cleanup passes `pnpm prepush:check`
(static checks, unit tests, and fresh coverage), deployment/image/exercise
checks, and regenerated source/risk evidence. The
[qualification record](./implementation-progress.md#current-qualification)
distinguishes these post-cleanup checks from the earlier full local-service
qualification and its three AWS-only exclusions. Neither establishes
production readiness.

The identity and team follow-up (2026-09-25) adds member removal
([ADR 042](./adr/042-workspace-member-removal.md)), self-service display names,
invitation acceptance under the active session authority and allowlisted
sign-in return paths
([ADR 043](./adr/043-self-service-profile-and-session-authority-journeys.md)),
with migrations `0110` and `0111`. Their contract, database, API and web
evidence is recorded in the
[web architecture plan](../apps/web/ARCHITECTURE.md#implemented-slice-member-removal-display-names-and-return-paths).

The membership lifecycle follow-up (2026-09-25) lets members leave a workspace,
lets owners and admins suspend and reactivate members, and lets the owner hand
the workspace to another member from a fresh sign-in
([ADR 047](./adr/047-workspace-membership-lifecycle.md)), with migrations
`0116`–`0118`. Its evidence is in the
[web architecture plan](../apps/web/ARCHITECTURE.md#implemented-slice-leaving-suspension-and-ownership-transfer).

## Open production evidence

- AWS IAM admission, immutable image/task invocation, versioned tenant buckets,
  Object Lock, legal hold/deletion, and dual-region control-ledger behavior.
- Deployed webhook/fan-out/long-wait/noisy-tenant load, fair admission,
  provider-failure, backpressure, worker-drain, Redis-loss, and object-storage
  failure exercises.
- Pager routing and response latency for API, queues, workers, triggers,
  PostgreSQL, Redis, object storage, and destructive maintenance.
- PostgreSQL backup/PITR, failover/failback, regional restore, writer fencing,
  five-minute RPO, 24-hour RTO, replica admission, and capacity observations.
- Production-like DNS/connect/TLS concurrency and latency evidence before any
  change to the safe no-pooling network policy.
- Deployed API/worker autoscaling observations under representative load and
  saturation.

The named external evidence families remain open: ART-002, ART-008, DB-011,
DB-017, INT-010, INT-013, OBS-006, and RL-002. The separately authorized
Q14/E01 packet defines per-drill identity, access, command, capability, and
cleanup fields for deployment, storage/security, providers, load/failure,
pager, migration/PITR, regional recovery, deletion, restore, and purge. A
filled packet is not execution evidence; local fakes, mocks, and repository
tests cannot close these obligations. The exact schemas and validation live in
[`infrastructure/ecs/external-platform-contract.json`](../infrastructure/ecs/external-platform-contract.json)
and [`operations/external-platform-contract.md`](./operations/external-platform-contract.md).

## Product reads after the phase plan

- Workspace run statistics
  ([ADR 044](./adr/044-bounded-workspace-run-statistics.md)):
  `GET /v1/workspaces/:workspaceId/run-statistics` returns exact current and
  fixed-window run counts from one snapshot, backed by a covering
  `workflow_runs` index. Its query-plan budget and workspace isolation are
  proven against a disposable database. It replaces the web's paged "100+"
  counts on Home, Runs and the spine.

## Current guidance

- Use the [codebase map](./codebase-map.md) for ownership and placement.
- Use the [local quality runbook](./operations/local-quality-verification.md)
  for isolated service-backed verification and its explicit exclusions.
- Use the [database readiness contract](../packages/database/src/platform/readiness.ts),
  [function-readiness runbook](./operations/database-function-readiness.md),
  [release/security gate](./operations/release-security-gate.md), and
  [regional recovery runbook](./operations/regional-recovery.md) for operational
  procedures and boundaries.
- All accepted architecture decisions remain under [`adr/`](./adr/). They are
  governing contracts, not proof that external obligations have been run.
- Post-plan read surfaces added for the web product, currently the webhook
  delivery log (ADR 045) and Slack channel names (ADR 046), are summarized in
  the [implementation progress follow-ups](./implementation-progress.md#weft-follow-up-reads-delivery-log-and-slack-channel-names).

The current migration baseline is `EXPECTED_MIGRATION_HEAD` in the database
readiness contract, with execution modes in the
[migration execution plan](../packages/database/migrations/migration-execution-plan.json).
Do not infer the current head from historical phase evidence.
