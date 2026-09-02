# Current Backend Implementation Status

Updated: 2026-09-02

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

Audited implementation tree: `4d3c24f10a8b501fb0f0f9b5afdf7a650a5d9125`

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
successfully, closing C-12. Risk coverage still names 23 exact selected files
with repository-relative paths. After removing tests coupled to mutable private
state, public-interface tests measure 90.64% workflow-engine, 94.23% database,
91.86% worker, and 99.64% API branch coverage. All 116 uncovered instrumentation
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
