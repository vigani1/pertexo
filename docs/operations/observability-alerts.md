# Observability Alert Runbook

This runbook covers the repository-owned Prometheus rules in
`infrastructure/observability/pertexo-alerts.yaml`. Start with durable truth in
PostgreSQL and bounded metric dimensions. Use trace and structured-log
correlation for individual requests, runs, and workspaces; do not add those
identifiers to metric labels.

## Shared Triage

1. Confirm the alert expression has current samples and note only bounded labels
   such as route, queue, operation, and outcome.
2. Correlate the alert window with deployment, worker drain, provider, and
   maintenance logs. Do not infer data loss from Redis or queue delay alone.
3. Check PostgreSQL-authoritative state before taking recovery action. Use the
   supported, reason-required operator command for recovery; never edit rows.
4. Preserve lifecycle and control-ledger fences. Do not bypass legal hold,
   leases, fencing tokens, or restore-before-serve agreement to clear an alert.
5. Record the alert start, user impact, command IDs used for recovery, and the
   time the expression returned below threshold.

## PertexoApiEligibleErrorBudgetBurn

Check eligible failures by route and problem code in the API panels. Correlate
5xx problem logs and recent releases, then verify durable run acceptance before
classifying impact. Roll back or stop the faulty serving revision if failures
are release-correlated; do not make the API ready when PostgreSQL authority is
unavailable.

## PertexoApiWriteLatencyHigh

Identify the affected write route and compare throughput with the admitted-load
envelope. Inspect database pool saturation, connection waiters, bounded query and
transaction latency, and sampled lock waits. SQL text and database identities are
intentionally absent; use traces and restricted database tooling for a specific
query only after the aggregate signal identifies the affected window.

## PertexoWebhookUnavailable

Confirm the finite webhook outcome and inspect ingress problem logs. Verify the
database acceptance path and outbox age. Acknowledge upstream retries; do not
manually create workflow runs for requests whose durable acceptance is unknown.

## PertexoScheduleScanLagHigh

Check schedule scan outcomes, deferred occurrences, trigger health, and queue
age. Restore trigger worker capacity or dependency readiness, then allow durable
schedule state to drive catch-up. Do not fabricate occurrences or advance
scheduler timestamps directly.

## PertexoScheduleToStartLatencyHigh

Compare scanner lag with coordinator queue age, active slots, and execution
admission saturation. The duration begins at the authoritative due occurrence
and ends only when `run.started` commits; do not treat queue acceptance as start.

## PertexoScheduleStartClockSkew

Compare PostgreSQL and worker host clocks before interpreting latency data. Keep
the affected observation out of latency percentiles and restore clock
synchronization; never rewrite durable occurrence or run timestamps.

## PertexoProviderFailureRateHigh

Split failures by the bounded provider and operation dimensions and inspect rate
limit signals. Apply the node retry classification and provider rate limits.
Never retry an unsafe ambiguous effect outside the persisted recovery command.

## PertexoOutboxOldestAgeHigh

Verify dispatcher readiness and publication outcomes, lease expiry/reclaim, and
queue acceptance. PostgreSQL remains authoritative. If a row needs intervention,
use the audited outbox redispatch command after confirming its current durable
state.

## PertexoQueueOldestJobAgeHigh

Identify the bounded queue, then check handler failures, stalls, forced drains,
and worker starts. Restore consumers or dependencies and allow identifier-only
jobs to resume from PostgreSQL truth. Redis loss is delay, not proof of run loss.

## PertexoTriggerReconciliationFailures

Inspect trigger lifecycle logs and the durable reconciliation target. Resolve
dependency or contract failures, then use the supported trigger-reconciliation
retry command with a reason. Confirm one durable outcome after retry.

## PertexoWorkerQueueStalls

Check handler duration, worker termination, event-loop symptoms in platform
telemetry, and BullMQ lock settings. A stalled delivery can be redelivered;
verify inbox, attempt, usage, and provider-effect truth before intervention.

## PertexoWorkerForcedDrain

Correlate the forced drain with deployment or shutdown logs and identify the
queue involved. Verify active work reached a truthful durable state and that the
replacement worker became ready. Escalate repeated forced drains as a resource
or timeout-envelope issue.

## PertexoWorkerRestartBurst

Correlate worker starts with deployments, task health events, and forced drains.
This counter does not distinguish planned rollout from crash churn by itself.
Inspect process CPU, RSS, heap, event-loop delay, and platform task-exit telemetry.

## PertexoDatabasePoolSaturated

Confirm both saturation and waiters are present; high utilization without queued
callers is not this alert. Compare API latency, durable backlog age, transaction
duration, and recent traffic or rollout changes. Reduce leaked/long transactions
before increasing pool capacity, and keep aggregate pool capacity below the
database connection budget.

## PertexoDatabaseLockWaits

The active value is a sampled observation limited to repository-owned backend
PIDs, and completed duration is a lower bound. Correlate the alert window with
transaction latency and PostgreSQL lock inspection. Resolve the owning operation
through restricted database tooling; never expose SQL or backend IDs as metric
labels and do not terminate sessions without confirming durable consequences.

## PertexoRedisFailureRateHigh

Split by finite client role, operation, outcome, and error class. Check connection
lifecycle events and queue/outbox age. Redis loss can delay queue delivery and
live notifications but PostgreSQL remains authoritative; restore connectivity and
allow outbox/replay paths to recover rather than fabricating durable state.

## PertexoObjectStoreSafetyViolation

Identify the bounded surface, region role, and check. Preserve integrity,
readiness, region-isolation, and restore-before-serve failures as fail-closed.
Inspect restricted object metadata and control-ledger reconciliation evidence;
never bypass checksum, immutability, or regional-isolation checks to clear the
alert.

## PertexoEventLoopDelayHigh

Compare p99 delay with process CPU, RSS, V8 heap, queue age, API latency, and
deployment timing. Identify synchronous work, allocation pressure, or host
contention before changing concurrency. CPU and memory are diagnostic safety
signals and are not sufficient by themselves to claim user impact.

## PertexoRetentionOperationFailure

Use the finite `operation` label to locate the failed stage: rerun processing,
scheduling, dry run, enforcement, preview, run-artifact retention, or workspace
purge. Inspect the structured error and durable lease/fence state. After fixing
the cause, use the audited retention or purge rerun command where applicable.

## PertexoRegionalWriteAdmissionPaused

Confirm the retention maintenance task is running and inspect its
`retention.regional_replica_lag` or `retention.regional_replica_lag_failed`
events. Verify that the authenticated RDS replica identity is
`pertexo-eu-west-1`, its state is streaming, and replay lag is below five
minutes. Do not bypass the database admission fence. Restore a fresh observation
by repairing monitoring or replication; admission resumes automatically only
after the persisted lag returns below the bound.

## PertexoWorkspacePurgeReleasedOrStale

Inspect the purge job's persisted step, lease, fence, legal-hold state, and
object deletion evidence. A released or stale attempt is retryable and is not a
completion claim. Use the purge rerun command only after active authority has
expired and retain the non-sensitive completion tombstone contract.

## PertexoLifecycleCommandFailure

Inspect the asynchronous lifecycle operation and bounded failure code, then
correlate lifecycle-command logs. Keep tenant access fenced for deletion and
keep restore suspended until both control ledgers agree. Retry through the
supported operation path rather than direct workspace mutation.

## PertexoControlLedgerDivergence

Stop or keep stopped tenant serving in the affected recovery context. Compare
the PostgreSQL projection high water with both immutable regional ledgers and
follow `docs/operations/regional-recovery.md`. Do not override reconciliation or
declare recovery complete from one ledger copy.

## Coverage Boundaries

Repository-owned PostgreSQL, Redis, object-store request/safety, and Node process
runtime signals are exported through the configured OpenTelemetry pipeline.
Object-store capacity, managed-service internals, database host capacity, ECS task
limits/exits, and cloud-provider replication health still require deployment-owned
AWS integrations. Current artifact inventory describes application metadata;
object-store request telemetry describes only calls made by this application and
is not a synthetic provider-availability probe.

Validate local assets with:

```sh
pnpm --filter @pertexo/observability test
docker compose -f infrastructure/observability/compose.yaml config
promtool check rules infrastructure/observability/pertexo-alerts.yaml
```

The final command requires a locally installed `promtool` or the pinned
Prometheus image.
