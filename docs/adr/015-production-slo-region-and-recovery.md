# ADR 015: Initial SLO, region, and recovery strategy

- **Status:** accepted
- **Date:** 2026-08-26

## Context

Pertexo needs a concrete launch topology and measurable recovery objectives
before production drills can prove readiness. The V1 plan targets EU customers,
an ECS/Fargate-class managed container platform, 99.9% monthly API and durable
run-acceptance availability, a five-minute PostgreSQL/object-storage RPO, and a
24-hour regional-disaster RTO. Multi-region active-active serving remains out of
scope.

## Decision

Production launches on AWS in `eu-central-1` (Frankfurt). At least two API tasks
and two worker tasks are spread across at least two availability zones and scale
independently. RDS PostgreSQL uses Multi-AZ failover, continuous WAL archiving,
automated point-in-time recovery, encrypted backups, and an encrypted
cross-region read replica in `eu-west-1` (Ireland). Redis remains transport only
and is rebuilt from PostgreSQL authority.

Ireland is a warm regional-recovery environment: the PostgreSQL replica, copied
container images, dual-written tenant-object versions, multi-region KMS recovery
capability, networking, secrets/configuration, and infrastructure definitions are maintained there,
while API and worker services have a desired count of zero. A declared recovery
follows this order:

1. Fence primary-region ingress and durable writes and record the recovery start.
2. Verify Ireland networking, KMS, secrets/configuration, images, and object
   buckets before starting application roles.
3. Confirm measured replica lag, promote PostgreSQL, and run database integrity
   and migration-compatibility checks.
4. Prove both control-ledger high waters agree and that every committed tenant
   object referenced by PostgreSQL exists with the expected checksum in Ireland.
5. Rebuild empty Redis transport from PostgreSQL authority.
6. Start API and worker roles behind a closed restore gate, reconcile every
   deletion and hold record, and run integrity and acceptance probes.
7. Open worker consumption, then perform an audited Route 53 API traffic cutover.

Failback builds a new replica from the recovered authority; it never writes
independently to both databases.

The authoritative control ledger is not an eventually replicated backup. Every
control command is conditionally appended to independently Object-Locked buckets
in both Frankfurt and Ireland before PostgreSQL projection. Failure or conflict
in either region rejects the command. Restore reconciliation reads both ledgers
through proven high water and requires identical sequence, record hashes, and
records before serving. Non-sensitive control-ledger records and their immutable
high-water history do not use the 35-day tenant-backup lifecycle and are retained
for V1 until a later accepted retention decision can preserve the same disaster
invariant.

Committed tenant artifacts and other required object bytes are also synchronously
written and checksum-validated in both regional buckets before PostgreSQL marks
their metadata finalized. A regional write failure rejects finalization. The
cross-region PostgreSQL replica is continuously monitored; durable write
admission pauses if replay lag reaches five minutes and resumes only below that
bound. These admission fences make the five-minute recovery-point objective an
enforced write property rather than an assumption about asynchronous copy speed.

The initial internal objectives are:

| Objective | Target |
| --- | ---: |
| API and durable run-acceptance availability | 99.9% monthly |
| API write latency | p95 below 500 ms under admitted load |
| Webhook durable acceptance | p95 below 1 second |
| Schedule-to-start latency | p95 below 5 seconds under admitted load |
| Persisted-to-visible event latency | p95 below 2 seconds |
| PostgreSQL and object-storage RPO | at most 5 minutes |
| Regional-disaster RTO | at most 24 hours |

Automated PostgreSQL backups, WAL archives, manual recovery points, snapshots,
tenant-object noncurrent versions, and their cross-region recovery copies become
ineligible for recovery no later than 35 days after creation. Lifecycle deletion
is asynchronous, so physical removal may occur later and its lag is measured and
alerted rather than represented as an exact erasure time. Manual recovery points
must carry an owner and expiry no later than that same limit; untracked snapshots
are prohibited.

A deleted tenant cannot be served from a backup: any restore remains unavailable
to tenant traffic until both authoritative control ledgers agree at proven high
water and every deletion record is re-applied. Configuration is not evidence;
launch requires measured Multi-AZ failover, point-in-time recovery, replica
promotion, regional dependency restoration, traffic cutover, and dual-ledger
reconciliation drills.

The availability SLI is the monthly ratio of eligible authenticated API requests
and durable run/webhook acceptance requests that return the documented correct
success, idempotent-replay, or valid business-conflict response. Client-invalid,
unauthorized, and legitimate tenant-quota rejections are excluded and reported
separately. Server errors, timeouts, and platform capacity/backpressure shedding
are unavailable outcomes. Scheduled production maintenance remains in the
denominator.

Latency is a separate percentile SLI over successful eligible requests and uses
the objective appropriate to each operation; it is never a per-request
availability cutoff. OpenTelemetry service metrics and ingress request records
are the measurement source. Correctness failures always consume the availability
error budget even when their response was fast. Exhausting the 0.1% monthly error
budget freezes routine releases until an approved reliability review.

## Consequences

The first release accepts a longer regional recovery time in exchange for
avoiding active-active consistency and operating cost. Multi-AZ failover covers
ordinary infrastructure loss, while a regional event invokes a separate,
audited recovery procedure. Missing or stale recovery copies, unavailable KMS
material, or an unreconciled control ledger fail closed and keep tenant serving
disabled.

The dual-region control-ledger coordinator, regional infrastructure, lifecycle
inventory, alerting, and measured drills remain implementation gates; choosing
AWS regions does not by itself prove them.

## Implementation note: regional write admission

Migration `0069_regional_write_admission.sql` implements the PostgreSQL side of
the recovery-point fence. Production migrations fail unless enforcement is
explicitly enabled. The maintenance role, which is the only application role
with `pg_monitor`, samples the configured `pertexo-eu-west-1` streaming replica
and records a bounded observation through a narrow security-definer function.
The persisted authority is open only below 300,000 milliseconds; missing,
non-streaming, null, or observations older than 15 seconds fail closed.

Every manual, webhook, schedule, and operator-replay run start reaches the same
transactional acceptance seam, which asserts this authority before creating a
new run. Exact idempotent replay is resolved first and remains available, while
reads and already-admitted execution are unaffected. Serving roles cannot read
or mutate the authority table directly. The maintenance process exports bounded
lag/admission metrics and transition logs, and the repository alert pages when
admission is blocked or observations disappear. Local integration tests prove
the exact threshold, recovery, stale/unavailable evidence, replica identity,
atomic rejection, and replay behavior. The live AWS replica and pager exercise
remains a separate release gate.
