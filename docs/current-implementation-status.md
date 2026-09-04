# Current Backend Implementation Status

Updated: 2026-09-04

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

Audited implementation tree: `8fa2a2df36cd125c275919914add3f25e3f49c22`

The 2026-09-03 whole-repository audit's repository-controlled correctness,
security, and runtime findings are complete at the implementation tree above.
That includes the worker production dependency and image role-load proof, owned
process shutdown, bounded logger redaction, patched dependencies, security
admission, selected risk coverage, production complexity decomposition,
UUIDv7/schema/RLS conventions, bounded async outcomes, package surfaces, and
public governance. A-11 is now complete: owner-local support modules remove
genuinely shared split-suite setup, while scenario state and assertions remain
visible. The exact scan fell from 25 groups/1,977 lines (2.08%) to 6 groups/267
lines (0.29%), and a pinned semantic baseline now rejects unexplained drift in
the root and protected CI checks. Database internals moved from 122 flat root
files to ten capability directories behind 12 stable entry points; the public
testing barrel fell from 567 to 85 physical lines. The latest
audit follow-up also makes persisted artifact identities UUIDv7, retains leases
while late publication marks settle, and proves compiled workers exit cleanly
after SIGINT or SIGTERM with consumers disabled or active and during bootstrap
failure.

The code audit now formalizes all currently evidenced residual implementation
work as C-21 through C-28. C-21/A-11, C-22, C-26, and C-28 are complete. C-23
is ratcheted complexity debt at 35 files and 40 functions; C-24 is continuous
risk-based coverage expansion; C-25 has an explicit ownership policy and is
mutation/profiling-gated; and C-27 activates when a large domain-shaped `.mjs`
tool changes materially. These do not change the
completed status of Phases 0–6 or turn evidence-gated/conditional cleanup into
an instruction for a mechanical repository-wide rewrite.
The exact findings and evidence are in `docs/whole-repository-audit.md`. These
do not change Phases 0–6; Phase 7 remains in progress only because its live
external evidence has not been executed.

Fresh local verification at this implementation tree passes `pnpm check`,
`pnpm test:coverage`, `pnpm release:check`, and `pnpm images:check`. Enabled
real-service cohorts pass 320 database, 22 worker, 15 API, and 5 artifact-store
tests. Coverage remains explicitly limited to 30 selected files/1,736 coverable
lines with 116 reviewed and zero unreviewed uncovered branches.

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
