# Database/workflow structural audit: complete scope register

Date: 2026-09-12. Status: scoped review complete; not an implementation plan.

## Why this supplements the first report

The [post-fix follow-up audit](post-fix-follow-up-audit.md) identified concrete
findings but did not enumerate every database/workflow module. This register
requires a disposition for the complete source set, not just large files or a
quota of recommendations. It also accounts for the process-entrypoint and
qualification gaps cited in the original assessment.

The scope is **179 database + 50 workflow-engine + 22 workflow-model source
files = 251**, plus **five process entrypoints**. This is not a fresh
file-by-file audit of all 658 repository sources. Other app/package modules,
tests, migrations and operational files are supporting evidence where they
govern an inspected interface. A complete inventory means every file in this
scope received a disposition; it cannot establish the absence of all possible
defects.

Reviewed baseline: `main`, HEAD `778a406256e5f70ed724f36a72018095ff828c51`,
tracking `origin/main`, 27 commits ahead, with the pre-existing uncommitted
implementation/test changes. The current source inventory fingerprint is
`sha256:e8cdc4353dfcf9b38a80759a1b81b12f73d825283c03426a810ea59c417d504e`.
Published migration bytes and the accepted ADRs remain authoritative.

## Review and completion rules

For each file, inspect its implementation, exported interface and ownership;
follow relevant callers and test seams; record whether the complexity protects
an invariant or creates avoidable caller knowledge, duplication or coupling.
An inventory generated from filenames, line counts, or imports alone is not a
completed review. Truncated reads must be completed before marking a file read.

- **KEEP:** current structure is appropriate; this is not a claim of zero bugs.
- **SIMPLIFY:** a specific behavior-preserving reduction is supported by caller
  evidence. A useful barrel is not automatically a simplification task.
- **SPLIT:** a concrete smaller interface and independent change responsibility
  justify extraction. Length alone is insufficient, and shared transaction/
  state-machine ownership must remain intact.
- **INVESTIGATE:** a named unresolved contract or evidence question; not
  permission to implement a speculative fix.

Correctness findings, conditional structure/performance work, test gaps and
external qualification are separate. Any non-KEEP recommendation needs an
identified reason, scope, invariants, and acceptance criteria. Retained earlier
decisions are not reopened merely because an arbitrary score is below ten.

## Source ledgers

- [Database per-file inventory](structural-inventory-database.md).
- [Workflow-engine and workflow-model per-file inventory](structural-inventory-workflow.md).

The final reconciliation checks the exact first-column source paths against
`rg --files` in the three source roots, including missing, extra and duplicate
rows. Source hashes are compared with the existing generated inventory. Test
references identify owning evidence, not a claim that every path executes.

All 251 core files and five entrypoints have been reviewed. Database structure
is retained in all 179 rows, with PF-04 tracked separately as a SQL correctness
fix. The workflow ledger has 66 KEEP, five INVESTIGATE and one SIMPLIFY rows.
No file split is justified solely by the current size or complexity score.

## Process-entrypoint ledger

These five files contain real orchestration and are currently explicitly
unmapped in [source coverage accounting](remaining-work/source-inventory.json).
PF identifiers refer to the detailed reproductions and acceptance criteria in
the [follow-up audit](post-fix-follow-up-audit.md).

| File | Structural disposition | Specific reason and action | Existing adjacent evidence, not main execution proof |
| --- | --- | --- | --- |
| `apps/api/src/main.ts` | SIMPLIFY | App-owned bootstrap remains appropriate; PF-02 replaces unsafe error classification and PF-03 must exercise telemetry-before-import ordering, listen failure and cleanup. Extract only enough orchestration to test it; no generic bootstrap framework. | `apps/api/test/api-bootstrap.test.ts` directly imports `src/app.ts`, not main. |
| `apps/worker/src/main.ts` | SIMPLIFY | Keep process-level creation and shutdown registration; PF-02/PF-03 cover safe failure output, partial construction and handler ownership. | `apps/worker/test/worker-bootstrap.test.ts`; `worker-process-lifecycle.test.ts` launches a fixture importing `dist/app.js` and shutdown handling, not main. |
| `apps/operator-command/src/main.ts` | SIMPLIFY | Preserve command-owned cleanup after `commandInvoked`; PF-02/PF-03 add safe fallback, signal listener removal and pre-handoff cleanup evidence. Do not duplicate `runOperatorCommand` ownership. | `apps/operator-command/test/config.test.ts`, `run.test.ts`. |
| `apps/recovery/src/main.ts` | SIMPLIFY | Preserve recovery-owned cleanup and telemetry initialization order; PF-02/PF-03 exercise all acquisition and handoff failures. Existing isolated synchronous close catches should stay. | `apps/recovery/test/config.test.ts`, `restore-before-serve.test.ts`. |
| `apps/retention/src/main.ts` | SIMPLIFY | PF-01 fixes cleanup short-circuit; PF-02/PF-03 cover safe error classification and actual handoff. One shared maintenance runtime remains the resource owner. | `apps/retention/test/config.test.ts`, `run.test.ts`, `metrics.test.ts`. |

Here SIMPLIFY means the specific diagnostic/testability corrections above,
not splitting every entrypoint by size. The five rows do not claim the entire
application packages received a new structural audit.

## Supporting mechanisms reviewed

| Mechanism | Disposition and limits |
| --- | --- |
| `apps/worker/src/runtime/worker-process-shutdown.ts` | KEEP the idempotent process signal owner; test its integration with actual main under PF-03. |
| `apps/worker/src/runtime/background-task-deadline.ts` | KEEP the bounded wait helper; it does not terminate a non-cooperative dependency. Actual process/container drain remains an E01-09 obligation. |
| `apps/operator-command/src/run.ts` | KEEP command dispatch plus ordered bounded cleanup; source coverage omission does not erase the direct run suite. Review diagnostic classification as part of PF-02. |
| `apps/recovery/src/restore-before-serve.ts` | KEEP reconciliation, inventory and owned cleanup; local tests do not prove deployed restore correctness. Review diagnostic classification as part of PF-02. |
| `apps/retention/src/run.ts` | KEEP one supervisor/resource lifetime; its cleanup attempts each resource, unlike the PF-01 pre-handoff path. |
| `apps/retention/src/maintenance-loops.ts` | KEEP distinct bounded maintenance loops and shared readiness/backoff policy; claimed cancellation must be exercised at the actual process seam, not inferred from passing fake adapters. |
| `apps/retention/src/metrics.ts` | KEEP fixed metric names and bounded domain dimensions; constructing instruments is not a reason to create another framework. |
| `infrastructure/generate-coverage-evidence.mjs` | KEEP explicit measurement versus static ownership distinction. It maps relative-import reachability and must never advertise those paths as executed coverage. |

## Cross-file checks

A current TypeScript-AST scan of static relative imports found **zero runtime
import cycles** across the 251 core files. The graph including type-only edges
has six multi-file clusters:

- database run API/replay;
- database coordinator plan/plan-validation/status-validation;
- engine scheduler/indexes;
- engine executable workflow/boundary/compilation/graph;
- engine persisted observations/parser; and
- engine operations/node-attempt input.

These are not runtime-cycle findings. Their contract ownership is assessed in
the file ledgers. The scan does not model runtime module loading through
package exports, computed imports, or all external dependencies.

The previous complexity baseline is a ceiling, not a current measurement or a
list of defects: it still mentions the deleted preview cleaner and the old
large `assertCheckpointMatchesExecutable` function. Current source and callers
take precedence over those historical entries.

## Evidence and external gaps remain separate

The repository source inventory covers 658 files: 428 measured runtime, 52
measured import/declaration/re-export files, 143 unselected runtime files with
static owner-suite mappings, five unmapped mains, and 30 build/type/export-only
dispositions. The 143 mappings are not execution evidence; the five mains are
not the only conceivable missing behavior tests.

The exact external list remains E00/E01-01 through E01-15, DB-011/017/016,
OBS-006, INT-010/013, ART-001/002/008, RL-002 and X01/X02 as recorded in
[the follow-up audit](post-fix-follow-up-audit.md) and
[the existing remaining-work register](remaining-work-plan.md). It requires
environment-specific authorization and receipts. No live provider, AWS,
GitHub protection, load, failover or destructive exercise is authorized here.

## Planning handoff

### Consolidated action register

These are distinct actions, not a requested quota of defects. Exact locations,
reproductions, invariants and acceptance criteria live in the linked findings.

| ID | Class | Concrete follow-up | Detail |
| --- | --- | --- | --- |
| PF-04 | P1 correctness; schema-static proof | Account for maintenance rerun rows in workspace purge; add an append-only migration and real PostgreSQL regression. | [Purge finding](post-fix-follow-up-audit.md#pf-04--maintenance-rerun-records-block-workspace-purge-completion) |
| PF-05 | P1 correctness; local reproduction | Make simultaneous cancellation/deadline precedence consistent for safe waiting nodes and the run. | [Workflow findings](structural-inventory-workflow.md) |
| PF-01 | P2 correctness; actual-source fault injection | Attempt all acquired retention-startup cleanup and preserve the initiating failure. | [Cleanup finding](post-fix-follow-up-audit.md#pf-01--retention-startup-cleanup-stops-after-one-close-failure) |
| PF-02 | P2 diagnostic hardening; actual-source fault injection | Replace arbitrary error-name output with bounded safe classification across all five process fallbacks. | [Diagnostic finding](post-fix-follow-up-audit.md#pf-02--process-fallback-diagnostics-trust-arbitrary-error-names) |
| PF-03 | Missing execution evidence | Test actual process-entrypoint orchestration, acquisition failure, handoff and cleanup rather than treating adjacent app tests as main execution. | [Follow-up audit](post-fix-follow-up-audit.md) and five-file ledger above |
| PF-06 | Conditional performance/structure | Compare private per-advance indexing/grouping with current repeated scans; select only if representative measurements justify it. | [Workflow findings](structural-inventory-workflow.md) |
| PF-07 | Open host-side hardening contract | Resolve top-level expression-context accessor handling; a local getter executes before canonicalization, but production callers use JSON and worker isolation is not shown broken. | [Workflow findings](structural-inventory-workflow.md) |
| WF-S01 | Optional interface cleanup | Resolve the testing-only cancellation return variant that has no producer; preserve the production state-machine owner. | [Workflow inventory](structural-inventory-workflow.md) |
| Existing external IDs | Qualification evidence | Execute the exact existing environment-specific criteria only after E00 authorization. | External-gap section above |

Do not implement merely because a row is non-KEEP. Preserve current public exports, checkpoint formats,
PostgreSQL authority, RLS, lock order, failure truth, and resource ownership.
Routine fixes/tests do not need new ADRs; consequential architecture changes do.

### Fresh verification for the expanded review

- Exact core-ledger reconciliation: 179 database and 72 workflow rows, no missing,
  extra or duplicate source paths.
- All 658 source hashes still match the source inventory; review did not change
  runtime source bytes.
- `pnpm architecture:check`: 15 tests passed; workspace/reference and static
  runtime-import checks passed.
- `pnpm complexity:check`: validator and two tests passed. This enforces the
  recorded ceiling, not absence of structural debt.
- Workflow-model build and unit suite: nine files, 97 tests passed.
- Documentation validation: 13 tests passed and 488 local links checked across
  100 documents; `git diff --check` passed.

The earlier database/engine test counts and diagnostic probes are recorded in
the first follow-up audit; they were not all rerun for this expansion. No live
PostgreSQL/provider tests or deployed qualification were run.

This expansion adds the three structural-inventory documents and a navigation
link from the first follow-up audit. No implementation, migration, commit or
push was performed. `main` remains 27 commits ahead of the locally recorded
`origin/main`; existing uncommitted source/test/config changes are preserved.
