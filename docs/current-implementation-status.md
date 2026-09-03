# Current Backend Implementation Status

Updated: 2026-09-03

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

Audited implementation tree: `6dc62b689974341d4e58af49e2f39ef84dc92b6e`

The 2026-09-03 whole-repository audit's repository-controlled correctness,
security, and runtime findings are complete at the implementation tree above.
That includes the worker production dependency and image role-load proof, owned
process shutdown, bounded logger redaction, patched dependencies, security
admission, selected risk coverage, production complexity decomposition,
UUIDv7/schema/RLS conventions, bounded async outcomes, package surfaces, and
public governance. Test files were decomposed below the 1,000-line limit, but a
post-remediation full-corpus clone scan partially reopened A-11: paired split
suites retain 1,977 duplicated lines (2.08%), and their shared setup needs an
owner-local extraction plus an automated non-regression baseline. The latest
audit follow-up also makes persisted artifact identities UUIDv7, retains leases
while late publication marks settle, and proves compiled workers exit cleanly
after SIGTERM with consumers disabled or active and during bootstrap failure.
The signal owner handles SIGINT through the same idempotent path, without
overstating the exercised process matrix.
The exact findings and evidence are in `docs/whole-repository-audit.md`. These
do not change Phases 0–6; Phase 7 remains in progress only because its live
external evidence has not been executed.

The 2026-09-01 audit refresh is implemented at fixed ancestor `0865633` and
merged to `main` through pull request #7. It
stabilizes destructive PostgreSQL service control, aligns Node 24 ambient and
runtime surfaces, reduces all eight named complexity hotspots, centralizes the
two same-owner helpers, binds local image evidence to its digest, splits
dependency compatibility groups, and strengthens risk-coverage evidence.

Local repository verification and all protected contexts in CI run
`33465359665` are green, including recovery. The later runtime-compatibility
pull request #23 run `33625443334` is also fully green after one retry of an
existing timing-sensitive integration assertion; its successful checks contain
no Node.js 20 action-runtime deprecation annotations. Live-production,
provider-canary, registry-signing, promotion, and independent-review findings
remain open until observed externally; they are not repository implementation
defects disguised as completed evidence.

The subsequent evidence correction structurally parses workflow YAML, fails
closed on dynamic or file-based Node selectors, and binds each selector to its
exact `setup-node` step, including case-insensitive GitHub repository identity
matching. The CI action pins now use immutable v6 releases that declare Node
24. The repository documentation command now structurally validates local
targets and anchors plus a shared merge-stable implementation tree. Protected
quality CI invokes it with complete history, and a fixture recreates the
candidate on a different parent to prove the supported rebase-style flow.
Pull request #26 and exact-main CI both executed that protected gate
successfully, closing C-12. Risk coverage names 30 exact selected files with
repository-relative paths. Public-interface tests measure 91.02% workflow-
engine, 95.38% database, 93.14% worker, and 100% API branch coverage across
1,736 coverable lines. All 116 uncovered instrumentation
branches have exact source-fingerprinted reviews; the eight integration-only
reviews each bind an exact command, file, and test name. The former 26 generic
integration classifications were withdrawn. The report rejects malformed,
duplicate, stale-source, and unsupported integration evidence, closing C-06
for the current selected cohort. The remediation also
centralizes the coordinator validation primitives privately and records the
fixed-revision
latency/memory/query comparison in
[`docs/operations/complexity-refactor-performance.md`](./operations/complexity-refactor-performance.md).

## Sources of truth

- [Authoritative backend plan](./workflow-platform-backend-plan.md)
- [Detailed implementation evidence and history](./implementation-progress.md)
- [Current whole-repository audit](./whole-repository-audit.md)
- [Architecture decisions](./adr/)
