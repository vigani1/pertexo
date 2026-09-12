# Post-fix audit: concrete follow-up candidates

Date: 2026-09-12. Status: **review record for a future plan; not implementation authorization**.

## Scope and interpretation

For the expanded file-by-file review and consolidated planning register, use
the [complete scoped structural inventory](structural-inventory.md). This first
report retains detailed PF-01–PF-06 evidence; it is not itself the full ledger.

This review checks the database/workflow complexity and evidence limitations
mentioned after the recent fixes. It does not turn a subjective score into a
refactoring target. A large state machine is not automatically broken, and an
uncovered branch is not automatically an untested behavior.

Baseline: `main`, HEAD `778a406256e5f70ed724f36a72018095ff828c51`, tracking
`origin/main` and 27 commits ahead. Existing implementation and test changes were
already uncommitted. All 658 source hashes match the current
[source inventory](remaining-work/source-inventory.json), fingerprint
`sha256:e8cdc4353dfcf9b38a80759a1b81b12f73d825283c03426a810ea59c417d504e`.
Line numbers below refer to this working tree, not HEAD alone.

The [previous closeout](remaining-work-plan.md) records its completed scope.
New findings here are additive; they do not reopen the fixed queue rejection or
Nest/PG telemetry sanitizer bugs. No source changes, migrations, commits, pushes,
service starts, or external exercises were performed in this review.

Disposition vocabulary:

- **Fix:** a locally reproduced failure or unsafe output path.
- **Evidence:** a specific missing execution proof, not a presumed behavior bug.
- **Conditional:** an optional, behavior-preserving improvement requiring a
  demonstrated reduction in caller knowledge or change coupling.
- **Retain:** complexity that currently protects an invariant; no automatic task.
- **External:** evidence requiring a separately approved deployed exercise.

## Local findings

### PF-01 — Retention startup cleanup stops after one close failure

**P2 · Fix · Confirmed with actual-source fault injection.**

Location: [retention main](../apps/retention/src/main.ts), lines 134–145,
particularly the unguarded synchronous closes at 141–142. Compare the isolated
close attempts in [recovery main](../apps/recovery/src/main.ts), lines 71–84.
The artifact and ledger close contracts can throw aggregate errors:
[artifact store](../packages/artifact-store/src/dual-region-artifact-store.ts),
lines 172–189, and [control ledger](../packages/artifact-store/src/dual-region-control-ledger.ts),
lines 300–320.

Reproduction used TypeScript's `transpileModule` on the unchanged retention
`main.ts`, CommonJS output in `node:vm`, and an explicit fake import table. No
database, AWS client, telemetry exporter, or real process signal handler ran.
Fake `createRetentionDatabase` threw the original `Error` after ledger, artifact,
and database-runtime construction; fake artifact `close()` threw `TypeError`.
The observed call sequence was:

```text
telemetry.start → log.fatal → runtime.close → artifacts.close
process_failed.errorType = TypeError; exitCode = 1
ledger.close = not called; telemetry.shutdown = not called
```

The cleanup failure skips remaining cleanup and replaces the original startup
failure reaching the process fallback. This is a failure-path correctness issue,
not evidence of a production incident.

Minimal correction: attempt every acquired resource's cleanup despite a prior
close failure, preserve the original startup error, and report cleanup failures
separately through safe diagnostics. Preserve the `workerInvoked` ownership
handoff so the worker and bootstrap do not both own normal cleanup. Do not add a
generic lifecycle framework for this fix.

Acceptance: fault each acquisition stage; fault artifact and ledger close
individually and together; verify all acquired resources receive exactly one
owned cleanup attempt, telemetry still shuts down, signal listeners are removed,
and the original failure remains authoritative. Rejections and synchronous
throws must both be considered where the interface permits them. Cover successful
handoff without duplicate close. Add a persistent regression through PF-03.

### PF-02 — Process fallback diagnostics trust arbitrary error names

**P2 · Fix/hardening · Confirmed synthetic output; no production leak alleged.**

The raw stderr fallback serializes `error.name` directly in all five entrypoints:

| File | Line containing raw classification |
| --- | ---: |
| [API main](../apps/api/src/main.ts) | 64 |
| [Worker main](../apps/worker/src/main.ts) | 61 |
| [Operator main](../apps/operator-command/src/main.ts) | 69 |
| [Recovery main](../apps/recovery/src/main.ts) | 97 |
| [Retention main](../apps/retention/src/main.ts) | 155 |

Actual-source VM probes supplied each config parser with
`Error('private detail')` whose name was `SyntheticSecretType`. All five wrote
that exact custom name to stderr and set exit code 1. The injected error is a
synthetic adversarial input, not a claim that today's config parser naturally
produces secret-bearing names. Any bootstrap failure reaching the fallback
crosses this same untrusted classification path.

This path bypasses the fixed span sanitizer entirely. Inner bootstrap log
metadata also repeats raw `error.name`; review both call sites per entrypoint
without reopening the now-fixed Nest/PG export path.

Minimal correction: use fixed classifications, never arbitrary name/message/code
text. Make classification non-throwing for getters and hostile prototype traps.
Preserve startup error identity and the process's failure exit status; do not
introduce a dependency that loads the full application before telemetry starts.
A small existing-package diagnostic helper is reasonable only if its startup
import behavior remains safe.

Acceptance: exercise the real startup/fallback path with custom names,
code-shaped synthetic markers, ordinary errors, primitives, property getters,
and throwing prototype traps. No marker reaches stdout/stderr or structured
metadata, no classifier prevents cleanup, and failed startup still exits nonzero.
Keep the existing event names and bounded useful diagnostics.

### PF-03 — Direct process-entrypoint behavior lacks execution evidence

**P2 · Evidence · Confirmed distinction between application and entrypoint tests.**

The five files in PF-02 are all explicitly `unmapped-runtime-source` in the
current inventory. They contain config parsing, telemetry-before-import order,
partial construction cleanup, ownership handoff, signal listener registration,
and process exit reporting. They are not declaration-only wrappers.

Existing [worker process fixture](../apps/worker/test/worker-process-lifecycle.fixture.mjs)
imports `dist/app.js` and `WorkerProcessShutdown`, not `dist/main.js`. The
[API bootstrap suite](../apps/api/test/api-bootstrap.test.ts) likewise tests the
application construction seam. Those are valuable tests, but they cannot close
PF-01/PF-02 or prove all production entrypoint orchestration.

Minimal scope: a local harness that executes the production entrypoint or a
small app-owned bootstrap function called by it, with controlled construction
dependencies. Preserve telemetry initialization before instrumented dynamic
imports. Keep real exit/signal assertions in isolated child processes; do not
copy the bootstrap implementation into a test fixture and call that coverage.
No live providers or credentials are needed. An extraction must preserve
existing build/start commands and resource ownership, not centralize every app
into one configurable bootstrap framework.

Acceptance per app: invalid config, telemetry start failure, import/construction
failure before and after resource acquisition, cleanup failure, successful
handoff, nonzero failed exit, and relevant SIGINT/SIGTERM cleanup. Count and
order calls, verify no duplicate cleanup and safe output. Capture genuine source
execution evidence separately from static import ownership. Regenerate inventory
and risk evidence after approved implementation; do not impose 100% coverage on
declarations or manufacture private-state hits.

## Database and workflow structural review

### PF-04 — Maintenance-rerun records block workspace purge completion

**P1 · Fix · Confirmed by current migration/control-flow inspection; real PostgreSQL regression still required.**

[Tenant-row purge migration](../packages/database/migrations/0057_workspace_tenant_rows_purge.sql)
lines 109–127 declares the deletion order and preserved tables. Lines 322–335
then fail closed on every other `app` table with a remaining `workspace_id` row.
[Maintenance-rerun migration](../packages/database/migrations/0066_operator_maintenance_rerun.sql)
lines 4–24 adds `operator_maintenance_rerun_requests`, which is in neither list.
It has a `workspace_id`, but no workspace/target foreign key that would delete
it transitively. Its only parent is the global `operator_commands` record.

Normal rerun requests insert this row at lines 129–132 and processing changes it
to `completed` at 211–217; neither path deletes it. Repository migration search
found no later replacement of the purge function or deletion path for this
table. After ordinary tenant rows are gone, the residual scan still sees the
request and raises SQLSTATE `55000`. Repeated purge attempts cannot complete the
`tenant_rows` step. This affects workspaces with such request records, not every
workspace or every operator command.

Important narrowing: `operator_unknown_outcome_evidence` and
`operator_run_replay_requests` are also absent from the explicit list, but their
FKs cascade from deleted attempts/runs/versions. Their omission alone is **not**
proof of the same bug. `operator_commands` itself has no `workspace_id` and is a
separate bounded command ledger; do not delete it indiscriminately.

Minimal correction: an **append-only migration** giving maintenance-rerun
records an explicit, bounded tenant-purge disposition and safe dependency order.
Preserve the fail-closed residual scan, legal holds, workspace scope, lease
token/fence checks, page limits, and the independent command ledger. Do not edit
migration 0057 or 0066 in place. Govern behavior by
[ADR 013](adr/013-retention-workspace-deletion-legal-hold.md).

Acceptance: on a disposable PostgreSQL database migrated to the current head,
create supported rerun records (pending and completed; retention and purge
targets), execute the supported workspace purge to completion, and verify the
tenant records disappear while another workspace remains unchanged. Cover
legal-hold pause/release, stale lease rejection, multiple bounded pages and
retry/resume. Include evidence/replay-request rows to prove their actual
cascade behavior. Test upgrade from the previous migration head, not only a
fresh schema. A migration string assertion cannot close this defect.

### PF-05 — Waiting-node cancellation loses to simultaneous deadline

**P1 · Fix · Reproduced through the existing engine test interface.**

[Workflow stops](../packages/workflow-engine/src/workflow-transition-stops.ts)
lines 26–35 chooses cancellation before deadline for loop control, but the
ordinary-invocation pass at 111–145 applies deadline first. It changes a waiting
node to `timed_out`; the cancellation pass at 147–164 then skips that terminal
node. [ADR 021](adr/021-durable-wait.md), lines 53–58, explicitly requires
committed cancellation to win for a purely waiting safe invocation when both
controls are first observed together.

Root reproduction rebuilt the package, used `dist/testing.js`'s existing
`advanceWorkflow`/`createCheckpointV2` interface, admitted one safe invocation,
and obtained its waiting checkpoint using a `wait` observation. No checkpoint
or branded executable was mutated. The next transition received both
`cancel_requested` and `deadline_expired` with zero admissions. Result:

```text
before: invocation=waiting, waitKind=node_wait
after:  invocation=timed_out, run=canceled
events: run.cancel_requested, node.timed_out, run.canceled
```

The production [advance operation](../packages/workflow-engine/src/operations.ts),
lines 171–225, can pass both controls into the same transition engine; the test
interface is not an alternative implementation. This review did not run a
database-backed Wait integration reproduction.

Minimal correction: make stop precedence consistent for ordinary and scoped
waiting invocations while preserving truthful `outcome_unknown` precedence,
running-attempt reconciliation, and already-terminal state. Do not broadly
rewrite the scheduler or change the persisted checkpoint format.

Acceptance: add a production `advanceWorkflow` regression with an authentic
compiled executable and serialized waiting state, plus the owning database/
worker Wait integration case. Simultaneous controls must emit `node.canceled`
and `run.canceled`, no `node.timed_out`, no resumed attempt, and no retained Wait
timing. Cover both input orders, cancellation-only, deadline-only, scoped Wait,
already-terminal nodes, active running attempts, and unsafe unknown outcomes.

### PF-06 — Repeated workflow scans are a conditional optimization candidate

**P3 · Conditional · Source-level repeated work confirmed; no latency regression measured.**

Two related hotspots warrant a bounded comparison, not a mandatory rewrite:

- [Coordinator observations](../packages/workflow-engine/src/coordinator-observations.ts),
  lines 375–380, copies the entire per-node successful-invocation array for each
  insertion. A group of N invocations incurs quadratic copying. Lines 312–318
  scan checkpoint invocations per active loop ordinal; lines 432–467 repeatedly
  search edges and projected invocations per merge branch.
- [Transition-state lookups](../packages/workflow-engine/src/workflow-transition-state.ts),
  lines 179–211, repeatedly flatten root/structured scheduler nodes and linearly
  search them for side-effect and disabled policy. Callers include
  [transition planning](../packages/workflow-engine/src/workflow-transition-plan.ts)
  lines 84 and 168, and [derived transitions](../packages/workflow-engine/src/workflow-transition-derived.ts)
  line 267.

Compare current code with one private prepared index per advance. Locally mutable
arrays/maps can build that index without making durable checkpoints mutable.
Measure representative and configured-limit fan-out/loop shapes before deciding
whether the extra index and memory are worthwhile. Preserve ordinal ordering,
scope-prefix matching, first-match behavior, side-effect policy, disabled nodes,
and fail-closed missing-node checks. Avoid a new public cache or generic graph
framework; data must not leak between runs.

Acceptance before selecting a refactor: exact plans/events/admission classes
match for duplicate/conflicting facts, nested scopes, stale loop observations,
joins and missing nodes; operation counts or repeatable benchmark results show
less repeated work without material memory regression. Retain current code if
the comparison does not justify the complexity. No blanket 1,000-node fixture
should violate the configured graph limits.

### Explicitly retain these dense modules

| Current cluster | Why it is dense | Disposition |
| --- | --- | --- |
| [Workspace purge coordinator](../packages/database/src/lifecycle/workspace-purge.ts), `processNext` at 345 | Lease/fence checks, short prepare/complete transactions, object operations and resumable steps must preserve exact ordering | Fix PF-04 in SQL; do not split this coordinator solely for length or move network work into its transactions |
| [Coordinator observation loading](../packages/database/src/execution/coordinator-run-store-observations.ts), fact validation at 267 and load at 510 | Bounded authoritative facts, physical-attempt consistency and semantic reconstruction share one snapshot contract | Retain existing transaction owner; no new defect or compelling smaller interface established |
| [Workspace transaction helper](../packages/database/src/tenant-access/workspace.ts) and [destructive-operation transaction helper](../packages/database/src/lifecycle/retention-transaction.ts) | Tenant context, cancellation, rollback, lock order and client ownership | Retain; existing guards are not redundant with RLS or HTTP authorization |
| [Checkpoint/executable validation](../packages/workflow-engine/src/checkpoint-executable-validation.ts), 22–241 | Distinct join, invocation, iteration and loop identity proofs | Current public function at 208 is already a short orchestration over private helpers; the historical 168-line function description is not a current justification for more splitting |
| [Workflow observations](../packages/workflow-engine/src/workflow-transition-observations.ts), [operations](../packages/workflow-engine/src/operations.ts), checkpoint parsers | Portable deterministic semantics and hostile serialized-state validation | Fix specific PF-05 precedence, retain semantic guards; no generic rules pipeline or test-only mutation of branded state |

This preserves the earlier DB-013 and M06–M08 retention decisions. The review
does **not** establish that every dense database/workflow file needs fixing.

### Boundary questions not promoted to implementation tasks

The workflow review noticed direct `runInput`/`nodeOutputs` reads before
canonicalization in [expression policy](../packages/workflow-model/src/expressions/policy.ts),
lines 317–329, and graph array-property normalization in
[graph contract](../packages/workflow-model/src/graph-contract.ts), lines 221–277.
Before any future hardening task, establish whether these inputs are untrusted
JavaScript objects or already-parsed JSON and whether stripping extras is an
intentional admission contract. No production exploit or caller violation was
established in this audit. Do not silently change accepted graph/context
semantics or count these questions as confirmed bugs. A future targeted review
would need public-caller evidence and accessor/non-index-property tests first.

## External evidence and retained limitations

These are existing obligations, not new missing implementations. Use the
[canonical external contract](operations/external-platform-contract.md),
[regional recovery runbook](operations/regional-recovery.md), and
[release security gate](operations/release-security-gate.md). Do not replace
their criteria with this summary.

| Existing IDs | Concrete remaining proof | Future action, not authorized here |
| --- | --- | --- |
| DB-011 | Representative tenant skew, burst cardinality, query plans, lock/WAL/vacuum behavior and fairness | Measure deployed workload against agreed budgets before changing queries/indexes; see [database review](remaining-work/database.md), lines 396–412 |
| DB-017, E01-07/13/14 | Actual pooler/RLS semantics, connection headroom, replica lag, backup/PITR and failover | Approved restore/failover exercise tied to deployment identity and RPO/RTO; database review lines 414–427 |
| DB-016 | Compatibility exception populations across every supported database | Run the existing M1/C1 retirement inventories before retirement; do not edit published migrations based on fresh-CI results |
| OBS-006 | Trace retention/access/sampling policy and real API → outbox → worker trace retrieval | Capture a trace ID and retrieve it in the deployed backend; local in-memory export proves a different criterion |
| E01-01…15, ART-008, INT-010, RL-002 | Deployed identity/IAM/Object Lock, providers, failures, load, alerts, retention and correct Redis topology | Use the exact scenario table in [remaining-work plan](remaining-work-plan.md); synthetic local tests cannot substitute for deployed receipts |
| INT-013, ART-001/002 | Real connection and cross-region latency/cost | Measure before proposing pooling or regional optimizations; preserve SSRF pinning and dual-region durability |
| X01/X02 | Image provenance/SBOM/scans, actual repository protection, independent review and exact release qualification | Collect fresh results tied to commit/image digest; an AI reviewer is not an independent human approver |

E00 is prerequisite: exact environment/regions/release identity, synthetic tenants,
resource and recipient allowlists, cost/time caps, operator/approver, stop and
rollback conditions, and evidence retention. No AWS/provider/GitHub writes,
deployment, messages, or destructive drills are authorized by this audit.

Worker shutdown retains a documented cooperative-cancellation limitation:
[background deadline](../apps/worker/src/runtime/background-task-deadline.ts)
bounds waiting, not the lifetime of a dependency that ignores cancellation.
Keep [the explicit limitation](remaining-work/apps.md), lines 24–30. E01-09 must
exercise actual worker/container termination and recovery; do not claim a local
timeout race kills arbitrary work, or reopen the already-fixed signal forwarding.

## Verification and planning handoff

Fresh checks in this review:

- Database unit suite: **85 files / 300 tests passed**; no integration services.
- Workflow-engine suite: **30 files / 346 tests passed**.
- Documentation checks: **13 tests passed**, 471 local links validated across
  97 files; `git diff --check` passed.
- All **658 source hashes** match the generated inventory.
- PF-01 actual-source VM reproduction: skipped cleanup and replacement error
  observed with bounded fake dependencies.
- PF-02 actual-source VM reproduction: custom name observed in all five stderr
  fallbacks. These probes are diagnostics, not newly committed regression tests.
- PF-04: checked migration definitions, current replacements, insertion/update
  paths and FK cascades; no live PostgreSQL reproduction in this review.
- PF-05: workflow-engine build passed; genuine transition-produced waiting
  checkpoint reproduces contradictory terminal statuses through the test interface.

The prior full local qualification and telemetry recheck remain prior evidence;
this audit did not rerun all integration cohorts or certify production readiness.

For the future plan: prioritize PF-04/PF-05 correctness, then PF-01/PF-02 with
PF-03 regression evidence; evaluate PF-06 only after measurement, and keep
external gates on their existing authorization track. Completion must cite behavior and source-matched
evidence, not a higher score. No new ADR is needed for routine fixes/tests;
any actual architectural change must follow the repository's ADR rules.
