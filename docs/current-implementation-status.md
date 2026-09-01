# Current Backend Implementation Status

Updated: 2026-09-01

## Delivery state

| Checkpoint | Status |
| --- | --- |
| Phase 0 — foundations and durability proof | Complete |
| Phase 1 — identity and workspace | Complete |
| Phase 2 — workflow authoring | Complete |
| Phase 3 — first executable node | Complete |
| Phase 4 — side-effecting integrations | Complete |
| Phase 5 — orchestration | Complete |
| Phase 6 — V1 providers and triggers | Complete |
| Phase 7 — production operations | In progress |

The repository-controlled Phase 7 implementation is substantially complete.
The platform must not be described as production-ready until the remaining live
AWS and operational exercises have fresh immutable evidence.

## Open production evidence

- IAM admission and immutable task/image invocation in the target AWS account.
- Versioned tenant buckets, Object Lock, legal hold/deletion, and replication.
- Deployed load, noisy-tenant fairness, provider-failure, and backpressure runs.
- Pager delivery latency and operator response exercise.
- Writer fencing, failover/failback, PITR, regional restore, RPO, and RTO drills.
- API/worker autoscaling observations and worst-case PostgreSQL connection
  capacity, including jobs, maintenance, migrations, and headroom.

These require the deployment account and cannot be replaced by repository-only
tests. The exact report schema and validator already live under
`infrastructure/exercises`.

## Current engineering remediation

The 2026-09-01 audit refresh is implemented at fixed ancestor `68752e7`. It
stabilizes destructive PostgreSQL service control, aligns Node 24 ambient and
runtime surfaces, reduces all eight named complexity hotspots, centralizes the
two same-owner helpers, binds local image evidence to its digest, splits
dependency compatibility groups, and strengthens risk-coverage evidence.

Local repository verification is green. The replacement implementation still
requires its protected remote CI run before the historical red recovery run can
be superseded. Live-production, provider-canary, registry-signing, promotion,
and independent-review findings remain open until observed externally; they are
not repository implementation defects disguised as completed evidence.

## Sources of truth

- [Authoritative backend plan](./workflow-platform-backend-plan.md)
- [Detailed implementation evidence and history](./implementation-progress.md)
- [Current whole-repository audit](./whole-repository-audit.md)
- [Architecture decisions](./adr/)
