# Remaining-work audit: workflow execution and node contract packages

Scoped audit and deterministic evidence update for
`packages/workflow-engine`, `packages/workflow-model`, `packages/node-sdk`,
`packages/node-catalog`, and `packages/nodes-core` at
`778a406256e5f70ed724f36a72018095ff828c51` (2026-09-12). The working tree was
already dirty. The later authorized implementation added owned workflow/SDK
tests, expanded source selection, and regenerated the shared evidence.

## Implementation closeout

F01–F04 are complete for repository-local scope. Serialized public-boundary
matrices first hit seven planning-snapshot rows, then expanded runtime selection
exposed 30 additional rows. Nine further public tests hit 26 of those 30 and
also covered additional retained guards. The final workflow-engine run passed
346 tests at 2,353/2,495 statements, 2,160/2,394 branches, 469/485 functions,
and 2,226/2,344 lines. The current risk snapshot contains 234 engine rows: 188
defensive, 34 unreachable, and 12 generated, with zero unreviewed.

All 17 omitted engine runtime modules that naturally execute under the owning
suite are now selected; only two declaration/export modules retain non-runtime
dispositions. Node-catalog `server-only.ts` is selected while its barrel keeps
build/export evidence. Node SDK hostile nested accessors, symbols, `Map`, null
prototype, and negative-zero cases preserve the intentional distinction between
browser admission and server canonicalization.

The 239-row table below is the planning snapshot, not current membership. Its
per-family recipes remain the historical rationale; the generated
[risk snapshot](risk-snapshot.json) is authoritative for current locators and
fingerprints.

## Result in one view

The scoped inventory contains 145 source files (50 engine, 22 model, 11 SDK,
5 catalog, and 57 core). The planning workflow-engine risk register contained
exactly 239 residual branch/condition rows across 26 files. Every planning row is
accounted for in the appendix, with the current machine-readable row preserved
verbatim. The register is not a claim that all 239 rows are safely executable
or that all public behavior is covered.

| Current row disposition | Rows | Meaning for remaining work |
| --- | ---: | --- |
| `defensive` | 196 | Caller/serialization/boundary or fail-closed guards. Retain as reviewed residuals; add a fixture only after tracing an authentic public path and naming the observable result. |
| `unreachable` | 31 | Current review hypothesis based on an upstream parser, graph compiler, closed union, or synchronous invariant. The hypothesis still needs complete producer/validator proof; do not mutate branded state or call private helpers to manufacture a hit. |
| `generated` | 12 | V8/Istanbul synthetic control flow with no executable source coordinate. Track the real adjacent decision; do not create a test for the line-zero row. |

All 239 planning rows carried the status `reviewed-uncovered`. That status means
the row was reviewed and remains uncovered in the current artifact; it is not
an exemption and not a promise that the row is reachable.

The prior 268-row workflow ledger had 161 `investigate` rows. Of those, 160
locations match the current register exactly: 159 are now `defensive`, and one
(`coordinator-observations` at `18/1`, line 144) is currently labelled
`unreachable` after observing that the public persisted-observation parser
rejects the missing invocation first. That observation is a route diagnostic,
not a complete producer/validator proof; the action map keeps it under `P`.
The prior persisted-observation locator `4/0` at line 123 moved to the current
`4/1` location in the same validation family. This explains the count and
locator delta; it is not evidence that the remaining defensive families are
fully tested.

## Public seam and evidence rules

The supported runtime boundary is the root `advanceWorkflow` operation with an
authentic, compiled executable and raw serialized checkpoint/observation data.
`parseWorkflowExecutableV2` is the public raw executable boundary. Tests may
use the existing authentic fixtures and raw JSON-compatible inputs. They must
not mutate an executable's brand/private maps, fabricate a half-valid
checkpoint after parsing, or call an internal helper merely to increment a
coverage counter.

The root operation validates the executable identity, parses the checkpoint,
cross-checks invocation identity, parses persisted observations, reconciles
completed outputs, derives coordinator observations, and advances scheduler
state. Representative in-memory checks confirmed these public diagnostics:

| Input | Confirmed result |
| --- | --- |
| observations object instead of array | `observation_invalid: observations must be an array` |
| deadline fact with numeric `occurredAt` | `observation_invalid: deadline timestamp is invalid` |
| attempt-failure fact with `occurredAt: "bad"` | `observation_invalid: attempt failure is invalid` |

These are representative diagnostics only; no full coverage rerun is claimed.

## Package-level disposition

The source inventory is complete for the five requested package prefixes. The
file-by-file disposition, including coverage-cohort inclusion and residual row
count, appears in the next section. Coverage numbers below are existing
artifacts, not a newly generated qualification run. Statement, function, and
branch percentages overlap in the usual way and must not be summed.

| Package | Source files | Runtime / declarations-only | Coverage cohort files | Existing coverage summary | Residual register |
| --- | ---: | ---: | ---: | --- | ---: |
| `workflow-engine` | 50 | 48 / 2 | 31 / 50 | lines 1,990/2,107 (94.44%); statements 2,106/2,245 (93.80%); functions 398/414 (96.13%); branches 1,980/2,211 (89.55%) | 239 rows; all current rows are here |
| `workflow-model` | 22 | 20 / 2 | 22 / 22 | lines 777/862 (90.13%); statements 815/937 (86.97%); functions 109/115 (94.78%); branches 556/696 (79.88%) | no current register rows; residual branches are reviewed by family below |
| `node-sdk` | 11 | 9 / 2 | 11 / 11 | lines 541/591 (91.53%); statements 567/624 (90.86%); functions 116/120 (96.66%); branches 325/391 (83.12%) | no current register rows; registry parity work is already present in the dirty tree |
| `node-catalog` | 5 | 4 / 1 | 3 / 5 | lines 146/150 (97.33%); statements 146/150 (97.33%); functions 28/28 (100%); branches 50/58 (86.20%) | no current register rows; `index.ts` and `server-only.ts` are outside the selected coverage cohort |
| `nodes-core` | 57 | 44 / 13 | 57 / 57 | lines 373/381 (97.90%); statements 387/396 (97.72%); functions 66/66 (100%); branches 184/196 (93.87%) | no current register rows; residual wiring is low-risk/static and package tests cover the node matrix |

### Workflow-engine families

The 239 rows cluster into finite families rather than 239 independent product
requirements:

| Family | Rows (defensive / unreachable / generated) | Disposition |
| --- | ---: | --- |
| Executable graph boundary/rules/validation/compatibility | 32 (28 / 4 / 0) | Public raw-envelope hostile-input and identity matrices are useful only where a fixture reaches the intended guard; compatibility guards are internal release invariants. |
| Checkpoint parsing, joins, loops, and identity | 25 (18 / 4 / 3) | Use authentic executable plus raw checkpoint through `advanceWorkflow` for malformed ledger/canonical identity cases; treat missing paired graph structures as `P` checks against complete graph-validator/producer constraints. |
| Root operation and coordinator output | 16 (11 / 3 / 2) | Keep the public operation as the seam; malformed output is a boundary case, while line-zero branches are generated. |
| Persisted observations | 48 (47 / 0 / 1) | Largest useful public matrix: duplicate consistency, stale correlation, due/deadline, retry/failure, ordering/gaps, and output-reference cases. |
| Coordinator derivation and failures | 33 (31 / 2 / 0) | Existing outcome tests cover the principal retry/cancel/deadline/unknown paths; add only a missing public correlation or failure-precedence case. |
| Scheduler, admission, attempts, and transition decisions | 33 (25 / 8 / 0) | Testing exports are typed seams for compact matrices, but remain internal policy helpers rather than product entry points. |
| Transition application and state | 25 (13 / 8 / 4) | Existing public transition tests cover declaration/replay/conflict/cancel/deadline; retain only proven raw-checkpoint gaps. |
| Transition derivation, planning, stops, output reference | 27 (23 / 2 / 2) | Active-loop cancel/deadline and terminal replay with changed output are bounded candidates; malformed active-loop topology needs complete upstream producer proof before any `P` row is closed. |

The family totals are 239. The exact rows, including file, branch index,
location, current disposition, status, and rationale, are in the final
appendix.

## Explicit planning action map for every risk file

The raw appendix preserves the current classification; it is not a proposed
completion state. The map below gives an unambiguous next action for every
exact file that owns a current row. Mixed files map each current disposition
separately.

| Action | Meaning |
| --- | --- |
| `A1` | Use a real public input boundary (`parseWorkflowExecutableV2` or raw checkpoint through `advanceWorkflow`) for a compact table; assert the stable error/value and stop if the intended guard is preceded by another check. The row remains `defensive` until reachability is demonstrated. |
| `A2` | Use the public root operation for coordinator/transition behavior; add only a distinct observable not already covered. The row remains `defensive` until that route is demonstrated. |
| `A3` | Optional typed internal/testing seam for scheduler/admission policy; use only for a named invariant and never treat the helper as a production API. The row remains `defensive` absent proof. |
| `P` | Prove or disprove the current `unreachable` classification from all production callers, validator constraints, and closed types. One rejected candidate is insufficient; if proof fails, change the row to `defensive` investigation. |
| `G` | Generated/no source-coordinate branch; track the adjacent real decision and do not add a line-zero test. |

| Exact file | Current rows | Proposed action (by current classification) |
| --- | --- | --- |
| `packages/workflow-engine/src/advance-workflow.ts` | defensive 1 | `A1`: verify the legacy root-join fallback with a valid raw checkpoint and assert canonical identity. |
| `packages/workflow-engine/src/checkpoint-executable-validation.ts` | defensive 13; unreachable 1; generated 1 | `A1` for malformed join ledger/canonical identity; `P` for missing iteration-path fallback; `G` for the implicit parser fallthrough. |
| `packages/workflow-engine/src/checkpoint-shared.ts` | unreachable 1; generated 1 | `P` for the synchronous non-empty traversal invariant; `G` for the implicit fallthrough. |
| `packages/workflow-engine/src/checkpoint-v1-join.ts` | defensive 2 | `A1`: exercise V1 count-join/malformed-count raw checkpoint cases through the public parser. |
| `packages/workflow-engine/src/checkpoint-v1.ts` | defensive 1; unreachable 1 | `A1` for the legacy invocation-key reconstruction; `P` for the schema-version dispatcher gate. |
| `packages/workflow-engine/src/checkpoint-v2.ts` | unreachable 1 | `P`: establish duplicate-key coalescing/rejection from the parser's complete producer path. |
| `packages/workflow-engine/src/checkpoint.ts` | defensive 2; generated 1 | `A1` only for a reachable malformed-checkpoint error route with the stable diagnostic; `G` for the synthetic branch. |
| `packages/workflow-engine/src/coordinator-failures.ts` | defensive 8 | `A2`: compare stale attempt, cancellation/deadline precedence, safe/non-safe dispatch, retry, and explicit unknown through the root operation; retain already-covered cases. |
| `packages/workflow-engine/src/coordinator-observations.ts` | defensive 23; unreachable 2 | `A2` for a public accepted correlated-output/duplicate-material case; `P` for the two missing-key arms, using persisted parser and graph producer evidence. |
| `packages/workflow-engine/src/coordinator-output.ts` | defensive 1; generated 1 | `A1` for an untrusted output-record boundary case; `G` for the synthetic branch. |
| `packages/workflow-engine/src/executable-compatibility.ts` | unreachable 3 | `P`: inspect validated release composition and adjacent-release producers; do not mutate a release to force the guard. |
| `packages/workflow-engine/src/executable-graph-boundary.ts` | defensive 7 | `A1`: add one fixture per distinct raw graph boundary family only after confirming the intended guard is reached. |
| `packages/workflow-engine/src/executable-graph-rules.ts` | defensive 19; unreachable 1 | `A1` for malformed graph/rule input; `P` for the rule guaranteed by graph compilation and pairing. |
| `packages/workflow-engine/src/executable-validation.ts` | defensive 2 | `A1`: use the public raw executable envelope for shape/identity/hostile-reflection diagnostics; do not force valid byte-boundary arms. |
| `packages/workflow-engine/src/graph-scheduler.ts` | defensive 11; unreachable 3 | `A3` for a compact typed capacity/ready/join matrix; `P` for ready-node/index invariants. |
| `packages/workflow-engine/src/node-attempt-input.ts` | defensive 5; unreachable 2 | `A3` for typed attempt-input admission cases; `P` for persisted topology guarantees. |
| `packages/workflow-engine/src/operations.ts` | defensive 9; unreachable 3; generated 1 | `A2` for root validation/cross-check cases; `P` for closed operation invariants; `G` for the synthetic branch. |
| `packages/workflow-engine/src/output-reference.ts` | generated 1 | `G`: no test; track the adjacent output-reference decision. |
| `packages/workflow-engine/src/persisted-observations.ts` | defensive 47; generated 1 | `A1`: highest-value compact fact-window/duplicate/stale/deadline/retry/output table; `G` for the synthetic branch. |
| `packages/workflow-engine/src/scheduling.ts` | defensive 8 | `A3`: typed capacity/disposition-ledger matrix with exact state assertions. |
| `packages/workflow-engine/src/transition-decisions.ts` | defensive 1; unreachable 3 | `A3` for missing-ready/capacity policy only where the seam is intentional; `P` for validated branch/index invariants. |
| `packages/workflow-engine/src/workflow-transition-derived.ts` | defensive 13; generated 1 | `A2`: active-loop/join derivation through a valid root transition; `G` for the synthetic branch. |
| `packages/workflow-engine/src/workflow-transition-observations.ts` | defensive 9; unreachable 6; generated 4 | `A2` for ordinary wait, terminal replay/output conflict, loop stop, and omission semantics; `P` for closed status/key mappings; `G` for synthetic branches. |
| `packages/workflow-engine/src/workflow-transition-plan.ts` | unreachable 2 | `P`: prove selected invocation keys always come from validated transition state. |
| `packages/workflow-engine/src/workflow-transition-state.ts` | defensive 4; unreachable 2 | `A3` for compatibility/default-scope and missing scheduler state cases via the supported seam; `P` for parser-proven loop invocation invariants. |
| `packages/workflow-engine/src/workflow-transition-stops.ts` | defensive 10 | `A2`: active-loop cancellation/deadline/terminal stop propagation through the root operation. |

This map deliberately does not promote the 196 current `defensive` rows to
“done.” Each remains either a bounded investigation candidate or a row whose
complete producer/validator proof has not yet been collected. Conversely, a
future public fixture that fails earlier does not by itself justify moving a
row to `unreachable`.

### Workflow-model residual branch families

These are coverage-artifact residuals, not a second risk register. Existing
model tests and the package audit establish that the complexity is intentional
and belongs to the graph/expression/canonicalization contracts. The current
family counts are:

| File/family | Residual branches | Disposition |
| --- | ---: | --- |
| `canonical-json.ts` | 3 | Preserve hostile/canonical JSON tests; do not add helper-only probes. |
| `expression-worker-runtime.ts` | 5 | Worker protocol test exists; add only a protocol regression with a new observable contract. |
| `graph-contract.ts` | 15 | Keep schema/port/edge contract matrix as the public seam. |
| `graph-validation.ts` | 7 | Retain graph validation invariants and malformed public graph cases. |
| `json-path.ts` | 9 | Add only a distinct path syntax/lookup contract not already in the parser matrix. |
| `mapping.ts` | 4 | Existing mapping validation is the seam; no private branch forcing. |
| `evaluator.ts` | 20 | Preserve evaluator policy and error behavior; avoid duplicate expression fixtures. |
| `policy.ts` | 12 | Keep policy matrix and fail-closed checks. |
| `aggregate.ts` / `graph.ts` / `identity.ts` | 10 / 0 / 5 | Aggregate/identity invariants are covered by graph boundary tests; no graph helper mutation. |
| `preflight.ts` | 26 | Large but intentional cross-node validation; extend only for a named plan/ADR contract. |
| `validation.ts` | 3 | Existing public validation contract is sufficient unless an error mapping changes. |

### Node contract packages

The current dirty `packages/node-sdk/test/registry.test.ts:468-512` now proves
browser/server rejection parity for a root-and-nested hostile matrix: undefined,
bigint, function, non-finite numbers, a root `Date`, symbol-bearing objects,
accessor objects (including nested accessor/symbol-bearing values), nested
undefined/bigint/function/non-finite/`Map` values, and nested arrays with extra
properties. It also asserts that the accessor is never invoked. Earlier tests
cover cycles, shared references, sparse/oversized arrays, extra root-array
properties, hostile reflection traps, scalar/envelope byte bounds, custom
limits, and exact member/depth bounds. The adjacent
`registry.test.ts:514-526` test separately proves that browser admission accepts
null-prototype JSON and `-0`, while the server canonicalizer returns an ordinary
object and `0`. It does not compare a browser-normalized value with the server
canonical value for those two valid cases, so full normalized parity remains a
small, explicit follow-up if that contract is required. These are current dirty
tree tests, not a claim that every SDK branch is closed; the SDK release, server
registry, and compatibility tests remain the public seams.

`node-catalog` has three selected runtime files (`definition-resolution.ts`,
`registry.ts`, `server.ts`) and two omitted files (`index.ts`,
`server-only.ts`). Existing definition-resolution, package-contract,
release-history, and server-registry tests cover the retained catalog behavior;
do not corrupt an immutable built-in release to force an internal guard.

`nodes-core` includes all 57 source files in its coverage cohort. The package
tests cover the core definition/executor/validation matrix and static registry
wiring. Its remaining registration/server fallbacks are lower-value wiring
guards; a new test needs a changed public contract, not a coverage-only target.

## F01–F04 deterministic evidence (2026-09-12)
The owned qualification added one serialized-boundary matrix with ten tests. It uses authentic executable/checkpoint transition output, JSON serialization, untrusted mutations, and the public `advanceWorkflow` operation; it does not mutate brands/private maps or call private helpers. Existing dirty-tree matrices remain the evidence for hostile executable JSON and SDK browser/server admission.
| Package | Tests | Typecheck | Coverage qualification | Result |
| --- | ---: | --- | --- | --- |
| `workflow-engine` | 336 passed / 28 files | passed | 2,106/2,245 statements; 1,980/2,211 branches; 398/414 functions; 1,990/2,107 lines | F02 serialized checkpoint/observation cases pass |
| `node-sdk` | 41 passed / 2 files | passed | 567/624 statements; 325/391 branches; 116/120 functions; 541/591 lines | F04 hostile nested accessor/symbol/Map and null-prototype/-0 normalization cases pass |
F01 planning-row reconciliation is explicit below. Of the 239 planning register
rows, seven defensive rows were hit by the first serialized
legacy-join/ledger cases; 232 remained at that intermediate point (including 31
producer/validator P rows and 12 generated G rows). “Retained-uncovered” records
an actionable public recipe or proof disposition and does not claim execution.
The closeout above and current machine snapshot supersede that intermediate
membership.
| Current register row | Source location | Classification | Evidence status | Exact evidence or next action |
| --- | ---: | --- | --- | --- |
| `packages/workflow-engine/src/advance-workflow.ts#7/0` | 92:12 | defensive | **hit** | serialized-boundary-matrices.test.ts: legacy root join or malformed join ledger |
| `packages/workflow-engine/src/checkpoint-executable-validation.ts#12/1` | 0:0 | generated | **retained-uncovered** | G — generated/no source coordinate; no execution claim. |
| `packages/workflow-engine/src/checkpoint-executable-validation.ts#2/1` | 37:8 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/checkpoint-executable-validation.ts#3/0` | 40:8 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/checkpoint-executable-validation.ts#4/0` | 42:2 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/checkpoint-executable-validation.ts#6/0` | 50:2 | defensive | **hit** | serialized-boundary-matrices.test.ts: legacy root join or malformed join ledger |
| `packages/workflow-engine/src/checkpoint-executable-validation.ts#7/1` | 58:36 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/checkpoint-executable-validation.ts#8/0` | 62:8 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/checkpoint-executable-validation.ts#9/0` | 65:2 | defensive | **hit** | serialized-boundary-matrices.test.ts: legacy root join or malformed join ledger |
| `packages/workflow-engine/src/checkpoint-executable-validation.ts#10/0` | 67:6 | defensive | **hit** | serialized-boundary-matrices.test.ts: legacy root join or malformed join ledger |
| `packages/workflow-engine/src/checkpoint-executable-validation.ts#10/1` | 67:38 | defensive | **hit** | serialized-boundary-matrices.test.ts: legacy root join or malformed join ledger |
| `packages/workflow-engine/src/checkpoint-executable-validation.ts#10/2` | 68:41 | defensive | **hit** | serialized-boundary-matrices.test.ts: legacy root join or malformed join ledger |
| `packages/workflow-engine/src/checkpoint-executable-validation.ts#11/0` | 69:7 | defensive | **hit** | serialized-boundary-matrices.test.ts: legacy root join or malformed join ledger |
| `packages/workflow-engine/src/checkpoint-executable-validation.ts#11/1` | 69:37 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/checkpoint-executable-validation.ts#12/0` | 70:4 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/checkpoint-executable-validation.ts#25/1` | 144:71 | unreachable | **retained-uncovered** | P — producer/validator proof retained in the register rationale; no synthetic state or execution claim. |
| `packages/workflow-engine/src/checkpoint-shared.ts#39/1` | 0:0 | generated | **retained-uncovered** | G — generated/no source coordinate; no execution claim. |
| `packages/workflow-engine/src/checkpoint-shared.ts#20/0` | 137:4 | unreachable | **retained-uncovered** | P — producer/validator proof retained in the register rationale; no synthetic state or execution claim. |
| `packages/workflow-engine/src/checkpoint-v1-join.ts#7/1` | 51:6 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/checkpoint-v1-join.ts#16/1` | 100:47 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/checkpoint-v1.ts#8/0` | 45:2 | unreachable | **retained-uncovered** | P — producer/validator proof retained in the register rationale; no synthetic state or execution claim. |
| `packages/workflow-engine/src/checkpoint-v1.ts#16/1` | 174:12 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/checkpoint-v2.ts#5/1` | 69:6 | unreachable | **retained-uncovered** | P — producer/validator proof retained in the register rationale; no synthetic state or execution claim. |
| `packages/workflow-engine/src/checkpoint.ts#5/1` | 0:0 | generated | **retained-uncovered** | G — generated/no source coordinate; no execution claim. |
| `packages/workflow-engine/src/checkpoint.ts#6/0` | 34:31 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/checkpoint.ts#6/1` | 34:47 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/coordinator-failures.ts#0/1` | 34:55 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/coordinator-failures.ts#1/0` | 35:4 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/coordinator-failures.ts#4/0` | 43:4 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/coordinator-failures.ts#6/0` | 48:12 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/coordinator-failures.ts#6/1` | 49:12 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/coordinator-failures.ts#7/0` | 50:14 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/coordinator-failures.ts#7/1` | 51:14 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/coordinator-failures.ts#12/0` | 101:46 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/coordinator-observations.ts#6/1` | 80:49 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/coordinator-observations.ts#7/0` | 81:4 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/coordinator-observations.ts#10/0` | 92:6 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/coordinator-observations.ts#14/0` | 114:4 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/coordinator-observations.ts#15/0` | 122:4 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/coordinator-observations.ts#17/1` | 143:10 | unreachable | **retained-uncovered** | P — producer/validator proof retained in the register rationale; no synthetic state or execution claim. |
| `packages/workflow-engine/src/coordinator-observations.ts#18/1` | 144:49 | unreachable | **retained-uncovered** | P — producer/validator proof retained in the register rationale; no synthetic state or execution claim. |
| `packages/workflow-engine/src/coordinator-observations.ts#26/0` | 206:4 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/coordinator-observations.ts#28/0` | 220:4 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/coordinator-observations.ts#29/1` | 226:49 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/coordinator-observations.ts#33/0` | 237:6 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/coordinator-observations.ts#34/0` | 245:4 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/coordinator-observations.ts#35/0` | 253:4 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/coordinator-observations.ts#37/0` | 274:4 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/coordinator-observations.ts#40/1` | 287:34 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/coordinator-observations.ts#50/1` | 341:42 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/coordinator-observations.ts#48/1` | 342:10 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/coordinator-observations.ts#55/1` | 345:43 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/coordinator-observations.ts#53/1` | 346:10 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/coordinator-observations.ts#59/0` | 366:4 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/coordinator-observations.ts#63/0` | 390:6 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/coordinator-observations.ts#65/0` | 399:12 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/coordinator-observations.ts#66/0` | 401:6 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/coordinator-observations.ts#79/0` | 472:20 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/coordinator-observations.ts#81/0` | 474:22 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/coordinator-output.ts#3/1` | 0:0 | generated | **retained-uncovered** | G — generated/no source coordinate; no execution claim. |
| `packages/workflow-engine/src/coordinator-output.ts#0/0` | 13:2 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/executable-compatibility.ts#0/0` | 20:4 | unreachable | **retained-uncovered** | P — producer/validator proof retained in the register rationale; no synthetic state or execution claim. |
| `packages/workflow-engine/src/executable-compatibility.ts#5/0` | 93:6 | unreachable | **retained-uncovered** | P — producer/validator proof retained in the register rationale; no synthetic state or execution claim. |
| `packages/workflow-engine/src/executable-compatibility.ts#8/0` | 104:6 | unreachable | **retained-uncovered** | P — producer/validator proof retained in the register rationale; no synthetic state or execution claim. |
| `packages/workflow-engine/src/executable-graph-boundary.ts#2/0` | 63:2 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/executable-graph-boundary.ts#7/1` | 153:6 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/executable-graph-boundary.ts#9/1` | 195:31 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/executable-graph-boundary.ts#10/0` | 215:4 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/executable-graph-boundary.ts#11/0` | 217:4 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/executable-graph-boundary.ts#14/0` | 227:4 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/executable-graph-boundary.ts#16/0` | 254:2 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/executable-graph-rules.ts#0/0` | 30:2 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/executable-graph-rules.ts#2/0` | 65:4 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/executable-graph-rules.ts#7/0` | 78:4 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/executable-graph-rules.ts#12/0` | 91:2 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/executable-graph-rules.ts#13/0` | 94:6 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/executable-graph-rules.ts#15/1` | 97:45 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/executable-graph-rules.ts#17/0` | 108:2 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/executable-graph-rules.ts#18/0` | 110:4 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/executable-graph-rules.ts#20/1` | 113:43 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/executable-graph-rules.ts#25/1` | 138:54 | unreachable | **retained-uncovered** | P — producer/validator proof retained in the register rationale; no synthetic state or execution claim. |
| `packages/workflow-engine/src/executable-graph-rules.ts#26/1` | 153:10 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/executable-graph-rules.ts#27/0` | 154:4 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/executable-graph-rules.ts#30/0` | 164:4 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/executable-graph-rules.ts#32/1` | 169:12 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/executable-graph-rules.ts#38/1` | 180:67 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/executable-graph-rules.ts#39/0` | 181:6 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/executable-graph-rules.ts#41/0` | 194:6 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/executable-graph-rules.ts#42/3` | 198:9 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/executable-graph-rules.ts#42/4` | 199:11 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/executable-graph-rules.ts#45/0` | 213:4 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/executable-validation.ts#17/0` | 88:4 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/executable-validation.ts#53/3` | 241:4 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/graph-scheduler.ts#35/1` | 0:0 | unreachable | **retained-uncovered** | P — producer/validator proof retained in the register rationale; no synthetic state or execution claim. |
| `packages/workflow-engine/src/graph-scheduler.ts#40/1` | 0:0 | unreachable | **retained-uncovered** | P — producer/validator proof retained in the register rationale; no synthetic state or execution claim. |
| `packages/workflow-engine/src/graph-scheduler.ts#4/0` | 52:2 | defensive | **retained-uncovered** | A3 — scheduler-projection.test.ts / advance-workflow-branching.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/graph-scheduler.ts#6/0` | 59:2 | defensive | **retained-uncovered** | A3 — scheduler-projection.test.ts / advance-workflow-branching.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/graph-scheduler.ts#7/1` | 63:8 | defensive | **retained-uncovered** | A3 — scheduler-projection.test.ts / advance-workflow-branching.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/graph-scheduler.ts#9/0` | 65:2 | defensive | **retained-uncovered** | A3 — scheduler-projection.test.ts / advance-workflow-branching.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/graph-scheduler.ts#21/1` | 124:6 | defensive | **retained-uncovered** | A3 — scheduler-projection.test.ts / advance-workflow-branching.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/graph-scheduler.ts#25/0` | 176:4 | defensive | **retained-uncovered** | A3 — scheduler-projection.test.ts / advance-workflow-branching.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/graph-scheduler.ts#28/1` | 179:46 | defensive | **retained-uncovered** | A3 — scheduler-projection.test.ts / advance-workflow-branching.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/graph-scheduler.ts#36/1` | 240:34 | defensive | **retained-uncovered** | A3 — scheduler-projection.test.ts / advance-workflow-branching.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/graph-scheduler.ts#37/0` | 257:27 | defensive | **retained-uncovered** | A3 — scheduler-projection.test.ts / advance-workflow-branching.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/graph-scheduler.ts#48/1` | 322:66 | defensive | **retained-uncovered** | A3 — scheduler-projection.test.ts / advance-workflow-branching.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/graph-scheduler.ts#52/1` | 353:64 | defensive | **retained-uncovered** | A3 — scheduler-projection.test.ts / advance-workflow-branching.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/graph-scheduler.ts#62/1` | 399:47 | unreachable | **retained-uncovered** | P — producer/validator proof retained in the register rationale; no synthetic state or execution claim. |
| `packages/workflow-engine/src/node-attempt-input.ts#8/2` | 88:4 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/node-attempt-input.ts#7/0` | 89:8 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/node-attempt-input.ts#13/0` | 117:2 | unreachable | **retained-uncovered** | P — producer/validator proof retained in the register rationale; no synthetic state or execution claim. |
| `packages/workflow-engine/src/node-attempt-input.ts#15/0` | 144:2 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/node-attempt-input.ts#24/0` | 196:2 | unreachable | **retained-uncovered** | P — producer/validator proof retained in the register rationale; no synthetic state or execution claim. |
| `packages/workflow-engine/src/node-attempt-input.ts#25/0` | 213:31 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/node-attempt-input.ts#25/1` | 213:47 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/operations.ts#20/1` | 0:0 | generated | **retained-uncovered** | G — generated/no source coordinate; no execution claim. |
| `packages/workflow-engine/src/operations.ts#3/1` | 111:37 | unreachable | **retained-uncovered** | P — producer/validator proof retained in the register rationale; no synthetic state or execution claim. |
| `packages/workflow-engine/src/operations.ts#16/0` | 337:4 | unreachable | **retained-uncovered** | P — producer/validator proof retained in the register rationale; no synthetic state or execution claim. |
| `packages/workflow-engine/src/operations.ts#20/0` | 360:6 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/operations.ts#21/0` | 360:10 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/operations.ts#21/1` | 360:28 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/operations.ts#22/0` | 364:4 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/operations.ts#23/1` | 366:7 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/operations.ts#23/2` | 366:53 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/operations.ts#24/0` | 369:4 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/operations.ts#26/0` | 404:4 | unreachable | **retained-uncovered** | P — producer/validator proof retained in the register rationale; no synthetic state or execution claim. |
| `packages/workflow-engine/src/operations.ts#28/1` | 411:47 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/operations.ts#31/0` | 453:4 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/output-reference.ts#4/1` | 0:0 | generated | **retained-uncovered** | G — generated/no source coordinate; no execution claim. |
| `packages/workflow-engine/src/persisted-observations.ts#30/1` | 0:0 | generated | **retained-uncovered** | G — generated/no source coordinate; no execution claim. |
| `packages/workflow-engine/src/persisted-observations.ts#3/0` | 110:6 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#4/1` | 123:47 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#5/0` | 132:2 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#7/0` | 138:2 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#8/0` | 140:2 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#9/0` | 142:6 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#9/1` | 143:6 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#9/2` | 144:6 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#9/3` | 145:6 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#9/4` | 146:6 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#10/0` | 148:2 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#11/0` | 150:6 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#11/1` | 151:6 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#11/2` | 152:6 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#11/3` | 153:6 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#11/4` | 154:6 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#11/5` | 155:6 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#11/6` | 156:6 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#11/7` | 157:6 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#11/8` | 158:7 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#13/0` | 158:7 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#13/1` | 158:41 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#12/0` | 159:10 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#12/1` | 160:10 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#14/0` | 160:10 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#14/1` | 160:39 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#15/0` | 162:2 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#17/0` | 177:2 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#18/0` | 179:2 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#19/0` | 182:8 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#19/1` | 183:8 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#20/0` | 186:2 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#21/0` | 191:6 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#21/1` | 192:6 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#21/2` | 193:6 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#21/3` | 194:6 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#22/5` | 210:10 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#25/0` | 227:6 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#26/0` | 230:12 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#26/1` | 231:12 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#28/0` | 242:6 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#29/1` | 244:8 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#32/0` | 254:4 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#33/1` | 256:6 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#34/1` | 264:6 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#35/0` | 270:4 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/persisted-observations.ts#54/1` | 334:14 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/scheduling.ts#0/0` | 40:2 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/scheduling.ts#4/0` | 55:4 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/scheduling.ts#5/0` | 58:4 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/scheduling.ts#10/0` | 80:2 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/scheduling.ts#17/0` | 143:2 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/scheduling.ts#19/0` | 150:4 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/scheduling.ts#28/0` | 192:2 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/scheduling.ts#31/0` | 223:2 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/transition-decisions.ts#3/1` | 36:68 | unreachable | **retained-uncovered** | P — producer/validator proof retained in the register rationale; no synthetic state or execution claim. |
| `packages/workflow-engine/src/transition-decisions.ts#7/0` | 45:6 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/transition-decisions.ts#9/1` | 54:34 | unreachable | **retained-uncovered** | P — producer/validator proof retained in the register rationale; no synthetic state or execution claim. |
| `packages/workflow-engine/src/transition-decisions.ts#13/0` | 73:4 | unreachable | **retained-uncovered** | P — producer/validator proof retained in the register rationale; no synthetic state or execution claim. |
| `packages/workflow-engine/src/workflow-transition-derived.ts#21/1` | 0:0 | generated | **retained-uncovered** | G — generated/no source coordinate; no execution claim. |
| `packages/workflow-engine/src/workflow-transition-derived.ts#3/0` | 44:4 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-derived.ts#8/0` | 82:4 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-derived.ts#9/1` | 82:30 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-derived.ts#10/0` | 83:4 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-derived.ts#11/1` | 98:65 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-derived.ts#12/1` | 107:45 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-derived.ts#17/0` | 143:10 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-derived.ts#19/0` | 146:4 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-derived.ts#22/0` | 171:4 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-derived.ts#25/0` | 200:2 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-derived.ts#27/0` | 213:9 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-derived.ts#31/0` | 258:8 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-derived.ts#33/0` | 271:23 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-observations.ts#4/1` | 0:0 | generated | **retained-uncovered** | G — generated/no source coordinate; no execution claim. |
| `packages/workflow-engine/src/workflow-transition-observations.ts#36/1` | 0:0 | generated | **retained-uncovered** | G — generated/no source coordinate; no execution claim. |
| `packages/workflow-engine/src/workflow-transition-observations.ts#63/1` | 0:0 | generated | **retained-uncovered** | G — generated/no source coordinate; no execution claim. |
| `packages/workflow-engine/src/workflow-transition-observations.ts#64/1` | 0:0 | generated | **retained-uncovered** | G — generated/no source coordinate; no execution claim. |
| `packages/workflow-engine/src/workflow-transition-observations.ts#9/0` | 81:8 | unreachable | **retained-uncovered** | P — producer/validator proof retained in the register rationale; no synthetic state or execution claim. |
| `packages/workflow-engine/src/workflow-transition-observations.ts#18/0` | 130:6 | unreachable | **retained-uncovered** | P — producer/validator proof retained in the register rationale; no synthetic state or execution claim. |
| `packages/workflow-engine/src/workflow-transition-observations.ts#18/1` | 131:6 | unreachable | **retained-uncovered** | P — producer/validator proof retained in the register rationale; no synthetic state or execution claim. |
| `packages/workflow-engine/src/workflow-transition-observations.ts#22/1` | 155:4 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-observations.ts#25/0` | 181:4 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-observations.ts#27/0` | 187:4 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-observations.ts#39/0` | 276:7 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-observations.ts#40/1` | 281:48 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-observations.ts#46/0` | 300:4 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-observations.ts#48/1` | 310:33 | unreachable | **retained-uncovered** | P — producer/validator proof retained in the register rationale; no synthetic state or execution claim. |
| `packages/workflow-engine/src/workflow-transition-observations.ts#49/0` | 318:2 | unreachable | **retained-uncovered** | P — producer/validator proof retained in the register rationale; no synthetic state or execution claim. |
| `packages/workflow-engine/src/workflow-transition-observations.ts#54/1` | 347:10 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-observations.ts#55/1` | 350:10 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-observations.ts#58/1` | 371:10 | defensive | **retained-uncovered** | A2 — operation-risk-branches.test.ts / serialized-boundary-matrices.test.ts; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-observations.ts#71/0` | 423:2 | unreachable | **retained-uncovered** | P — producer/validator proof retained in the register rationale; no synthetic state or execution claim. |
| `packages/workflow-engine/src/workflow-transition-plan.ts#2/0` | 59:4 | unreachable | **retained-uncovered** | P — producer/validator proof retained in the register rationale; no synthetic state or execution claim. |
| `packages/workflow-engine/src/workflow-transition-plan.ts#14/0` | 160:6 | unreachable | **retained-uncovered** | P — producer/validator proof retained in the register rationale; no synthetic state or execution claim. |
| `packages/workflow-engine/src/workflow-transition-state.ts#9/1` | 120:56 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-state.ts#16/0` | 192:2 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-state.ts#17/0` | 204:2 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-state.ts#18/1` | 208:76 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-state.ts#21/0` | 245:4 | unreachable | **retained-uncovered** | P — producer/validator proof retained in the register rationale; no synthetic state or execution claim. |
| `packages/workflow-engine/src/workflow-transition-state.ts#24/0` | 273:4 | unreachable | **retained-uncovered** | P — producer/validator proof retained in the register rationale; no synthetic state or execution claim. |
| `packages/workflow-engine/src/workflow-transition-stops.ts#5/0` | 39:6 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-stops.ts#7/0` | 51:10 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-stops.ts#9/0` | 71:8 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-stops.ts#10/0` | 78:6 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-stops.ts#14/1` | 90:54 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-stops.ts#16/1` | 102:19 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-stops.ts#17/0` | 102:19 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-stops.ts#17/1` | 102:52 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-stops.ts#22/1` | 123:13 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |
| `packages/workflow-engine/src/workflow-transition-stops.ts#23/1` | 136:61 | defensive | **retained-uncovered** | A1 — public boundary recipe in the action map; current row remains unexecuted. |

F03 disposition: all seventeen runtime-bearing engine files from the original
nineteen-file omission now belong to the selected workflow-engine cohort; the
two declaration/export files retain build/type/export evidence. Node SDK remains
11/11 selected. Node catalog now measures `server-only.ts`; only its declaration
barrel stays on build/export evidence. `workflow-model` and `nodes-core` remain
fully included (22/22 and 57/57). This closes the measurement obligation without
calling a previously omitted file untested or lowering a threshold.

`node-sdk` F04 intentionally separates browser validation from server canonicalization for valid null-prototype objects and `-0`: browser admission accepts the values, while server normalization returns ordinary objects and 0. The hostile nested accessor/symbol/Map matrix and getter non-execution assertion remain covered. No browser-normalization behavior was invented.

## Bounded, falsifiable follow-up work

The audit is complete as a disposition exercise. If implementation of remaining
tests is requested, the following finite batches are the only currently
supported candidates. Each batch has an entry seam, a falsifiable assertion,
and a stop condition. A candidate rejected by an earlier parser is evidence
about that candidate's route only; it does not classify the whole row or family
as invariant-unreachable. Keep the current row `defensive`/investigative until
all production callers and validator/producer constraints prove the invariant.

1. **Persisted observation admission (highest value).** Through
   `advanceWorkflow`, use one valid executable/checkpoint and a compact table
   for: same-sequence/different-output duplicate; stale terminal mismatch;
   due-versus-early/non-resumable wait; attempt-failure conflict, deadline,
   retry, safe/non-safe dispatch, and explicit unknown; ordering/gap; and
   optional output-reference equality/absence. Assert the stable public error
   code/message or unchanged checkpoint for idempotent replay. If a case is
   rejected by an earlier parser/identity guard, record the observed preceding
   route and keep the row under investigation; only a complete producer/validator
   proof may move it to `unreachable`.

2. **Checkpoint identity/grammar.** Through raw checkpoint input at
   `advanceWorkflow`, exercise one malformed join ledger, one legacy root join
   key accepted by the compatibility rule, one mismatched canonical scope,
   and one malformed loop identity/bounds case. Assert the exact identity or
   checkpoint error and no admission. For missing paired Parallel/branch
   topology, first collect complete authentic executable graph-validator and
   producer evidence; an earlier rejection alone does not close the row.

3. **Coordinator outcomes and transitions.** Retain existing tests for
   Condition/Switch, Parallel/For Each, Merge, retry, cancellation, deadline,
   unsafe unknown, and explicit unknown. Add only if diagnostics show a real
   gap: a stale invocation failure, cancellation/deadline precedence, an
   active-loop body terminal cause, ordinary waiting settlement, or terminal
   replay with changed output. Assert state/event/output identity through the
   public operation. Never call private transition helpers to manufacture a
   row.

4. **Executable raw-boundary matrix.** At `parseWorkflowExecutableV2`, retain
   valid escaped/control/non-ASCII/`-0` values and add one malformed case per
   distinct family (cycle/accessor/prototype/symbol/hidden/sparse/deep/member
   limit/oversize). Assert `executable_invalid` and that hostile getters are
   not invoked. Do not duplicate byte-boundary cases already covered upstream
   or force compatibility-release internals.

5. **Internal scheduler seam, only if needed.** The exported testing graph and
   scheduler helpers can receive a small typed matrix for capacity, join
   settlement, loop admission, and missing-ready-node fail-closed behavior.
   This is optional evidence for policy helpers, not a replacement for root
   operation tests. Do not promote a helper export to a production public API.

Expected follow-up size is bounded to a few public tables (roughly 20–35 cases,
depending on diagnostics), not 196 one-row tests. The audit itself needs no
production code change and no threshold adjustment. If a candidate exposes a
behavior defect rather than a coverage gap, stop and record it as a separate
contract fix.

## Plan and ADR alignment retained

The reviewed package boundaries continue to match the authoritative backend
plan and existing ADRs:

- `workflow-model` owns graph, identity, validation, mappings, expressions, and
  lifecycle contracts; it does not import the engine or infrastructure.
- `workflow-engine` is framework-independent and owns checkpoint parsing,
  scheduler/interpreter state, deterministic joins/loops, retries, and
  observation application. It does not import NestJS, database, Redis, HTTP,
  or queue code.
- `node-sdk` owns node-definition/executor contracts, bounded JSON, release
  identity, and compatibility projections; `node-catalog` owns staged/active
  release composition; `nodes-core` owns browser-safe core definitions and
  executors.
- Immutable executable identity, explicit bounded loops, deterministic Merge,
  PostgreSQL-authoritative runtime state, at-least-once side effects, and
  `outcome_unknown` semantics remain the governing constraints from the plan
  and ADRs 001, 007, 008, 010, 011, 019, and 026 where applicable.

No ADR is needed for this read-only disposition. A new ADR is required only if
future implementation changes one of those architectural seams or policies.

## Source inventory

The following generated table is the complete disposition for the 145 source
files in the five scoped package prefixes. `runtime` is the conservative source
classification from the inventory; `decl/reexport` means declarations,
imports, or reexports only. `coverage` records whether the file is present in
the package's current coverage cohort. `risk` is the exact number of current
workflow-engine register rows associated with that file (zero outside the
engine).

| File | Source disposition | Coverage cohort | Risk rows |
| --- | --- | --- | ---: |
| `packages/workflow-engine/src/advance-workflow.ts` | runtime | yes | 1 (defensive 1) |
| `packages/workflow-engine/src/checkpoint-executable-validation.ts` | runtime | yes | 15 (defensive 13, unreachable 1, generated 1) |
| `packages/workflow-engine/src/checkpoint-identity.ts` | runtime | no | 0 |
| `packages/workflow-engine/src/checkpoint-shared.ts` | runtime | yes | 2 (unreachable 1, generated 1) |
| `packages/workflow-engine/src/checkpoint-v1-join.ts` | runtime | yes | 2 (defensive 2) |
| `packages/workflow-engine/src/checkpoint-v1-loop.ts` | runtime | yes | 0 |
| `packages/workflow-engine/src/checkpoint-v1.ts` | runtime | yes | 2 (defensive 1, unreachable 1) |
| `packages/workflow-engine/src/checkpoint-v2.ts` | runtime | yes | 1 (unreachable 1) |
| `packages/workflow-engine/src/checkpoint.ts` | runtime | yes | 3 (defensive 2, generated 1) |
| `packages/workflow-engine/src/coordinator-failures.ts` | runtime | yes | 8 (defensive 8) |
| `packages/workflow-engine/src/coordinator-observations.ts` | runtime | yes | 25 (defensive 23, unreachable 2) |
| `packages/workflow-engine/src/coordinator-output.ts` | runtime | yes | 2 (defensive 1, generated 1) |
| `packages/workflow-engine/src/core-definition-identities.ts` | runtime | no | 0 |
| `packages/workflow-engine/src/errors.ts` | runtime | no | 0 |
| `packages/workflow-engine/src/executable-boundary.ts` | runtime | no | 0 |
| `packages/workflow-engine/src/executable-compatibility.ts` | runtime | yes | 3 (unreachable 3) |
| `packages/workflow-engine/src/executable-compilation.ts` | runtime | no | 0 |
| `packages/workflow-engine/src/executable-foundation.ts` | runtime | no | 0 |
| `packages/workflow-engine/src/executable-graph-boundary.ts` | runtime | yes | 7 (defensive 7) |
| `packages/workflow-engine/src/executable-graph-rules.ts` | runtime | yes | 20 (defensive 19, unreachable 1) |
| `packages/workflow-engine/src/executable-graph-validation-index.ts` | runtime | no | 0 |
| `packages/workflow-engine/src/executable-graph.ts` | runtime | yes | 0 |
| `packages/workflow-engine/src/executable-identity.ts` | runtime | no | 0 |
| `packages/workflow-engine/src/executable-validation.ts` | runtime | yes | 2 (defensive 2) |
| `packages/workflow-engine/src/executable-workflow.ts` | decl/reexport | no | 0 |
| `packages/workflow-engine/src/graph-scheduler-indexes.ts` | runtime | no | 0 |
| `packages/workflow-engine/src/graph-scheduler.ts` | runtime | yes | 14 (defensive 11, unreachable 3) |
| `packages/workflow-engine/src/index.ts` | decl/reexport | no | 0 |
| `packages/workflow-engine/src/node-attempt-input.ts` | runtime | yes | 7 (defensive 5, unreachable 2) |
| `packages/workflow-engine/src/operation-values.ts` | runtime | no | 0 |
| `packages/workflow-engine/src/operations.ts` | runtime | yes | 13 (defensive 9, unreachable 3, generated 1) |
| `packages/workflow-engine/src/ordering.ts` | runtime | no | 0 |
| `packages/workflow-engine/src/output-reference.ts` | runtime | yes | 1 (generated 1) |
| `packages/workflow-engine/src/persisted-observation-parser.ts` | runtime | yes | 0 |
| `packages/workflow-engine/src/persisted-observations.ts` | runtime | yes | 48 (defensive 47, generated 1) |
| `packages/workflow-engine/src/retries.ts` | runtime | yes | 0 |
| `packages/workflow-engine/src/runtime.ts` | runtime | no | 0 |
| `packages/workflow-engine/src/scheduling.ts` | runtime | yes | 8 (defensive 8) |
| `packages/workflow-engine/src/scope.ts` | runtime | no | 0 |
| `packages/workflow-engine/src/server-only.ts` | runtime | no | 0 |
| `packages/workflow-engine/src/testing-graph.ts` | runtime | no | 0 |
| `packages/workflow-engine/src/testing.ts` | runtime | no | 0 |
| `packages/workflow-engine/src/transition-decisions.ts` | runtime | yes | 4 (defensive 1, unreachable 3) |
| `packages/workflow-engine/src/transitions.ts` | runtime | yes | 0 |
| `packages/workflow-engine/src/types.ts` | runtime | no | 0 |
| `packages/workflow-engine/src/workflow-transition-derived.ts` | runtime | yes | 14 (defensive 13, generated 1) |
| `packages/workflow-engine/src/workflow-transition-observations.ts` | runtime | yes | 19 (defensive 9, unreachable 6, generated 4) |
| `packages/workflow-engine/src/workflow-transition-plan.ts` | runtime | yes | 2 (unreachable 2) |
| `packages/workflow-engine/src/workflow-transition-state.ts` | runtime | yes | 6 (defensive 4, unreachable 2) |
| `packages/workflow-engine/src/workflow-transition-stops.ts` | runtime | yes | 10 (defensive 10) |
| `packages/workflow-model/src/assert-never.ts` | runtime | yes | 0 |
| `packages/workflow-model/src/canonical-json.ts` | runtime | yes | 0 |
| `packages/workflow-model/src/expression-worker-runtime.ts` | runtime | yes | 0 |
| `packages/workflow-model/src/expressions.ts` | decl/reexport | yes | 0 |
| `packages/workflow-model/src/expressions/evaluator.ts` | runtime | yes | 0 |
| `packages/workflow-model/src/expressions/policy.ts` | runtime | yes | 0 |
| `packages/workflow-model/src/failure-notification.ts` | runtime | yes | 0 |
| `packages/workflow-model/src/graph-contract.ts` | runtime | yes | 0 |
| `packages/workflow-model/src/graph-validation.ts` | runtime | yes | 0 |
| `packages/workflow-model/src/graph.ts` | runtime | yes | 0 |
| `packages/workflow-model/src/graph/aggregate.ts` | runtime | yes | 0 |
| `packages/workflow-model/src/graph/identity.ts` | runtime | yes | 0 |
| `packages/workflow-model/src/graph/preflight.ts` | runtime | yes | 0 |
| `packages/workflow-model/src/graph/validation-contract.ts` | runtime | yes | 0 |
| `packages/workflow-model/src/graph/validation.ts` | runtime | yes | 0 |
| `packages/workflow-model/src/index.ts` | decl/reexport | yes | 0 |
| `packages/workflow-model/src/invocation-identity.ts` | runtime | yes | 0 |
| `packages/workflow-model/src/json-path.ts` | runtime | yes | 0 |
| `packages/workflow-model/src/lifecycle.ts` | runtime | yes | 0 |
| `packages/workflow-model/src/mapping.ts` | runtime | yes | 0 |
| `packages/workflow-model/src/observation-window.ts` | runtime | yes | 0 |
| `packages/workflow-model/src/server-only.ts` | runtime | yes | 0 |
| `packages/node-sdk/src/compatibility-canonical.ts` | runtime | yes | 0 |
| `packages/node-sdk/src/definitions/schema-document.ts` | runtime | yes | 0 |
| `packages/node-sdk/src/executor-contracts.ts` | decl/reexport | yes | 0 |
| `packages/node-sdk/src/executor-errors.ts` | runtime | yes | 0 |
| `packages/node-sdk/src/identity.ts` | runtime | yes | 0 |
| `packages/node-sdk/src/index.ts` | decl/reexport | yes | 0 |
| `packages/node-sdk/src/json-boundary.ts` | runtime | yes | 0 |
| `packages/node-sdk/src/registry-binding.ts` | runtime | yes | 0 |
| `packages/node-sdk/src/release.ts` | runtime | yes | 0 |
| `packages/node-sdk/src/server-only.ts` | runtime | yes | 0 |
| `packages/node-sdk/src/server.ts` | runtime | yes | 0 |
| `packages/node-catalog/src/definition-resolution.ts` | runtime | yes | 0 |
| `packages/node-catalog/src/index.ts` | decl/reexport | no | 0 |
| `packages/node-catalog/src/registry.ts` | runtime | yes | 0 |
| `packages/node-catalog/src/server-only.ts` | runtime | no | 0 |
| `packages/node-catalog/src/server.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/condition/definition.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/condition/executor.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/condition/index.ts` | decl/reexport | yes | 0 |
| `packages/nodes-core/src/condition/validation.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/definitions.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/for-each/definition.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/for-each/executor.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/for-each/index.ts` | decl/reexport | yes | 0 |
| `packages/nodes-core/src/for-each/validation.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/index.ts` | decl/reexport | yes | 0 |
| `packages/nodes-core/src/manual/definition.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/manual/executor.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/manual/index.ts` | decl/reexport | yes | 0 |
| `packages/nodes-core/src/manual/validation.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/merge/definition.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/merge/executor.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/merge/index.ts` | decl/reexport | yes | 0 |
| `packages/nodes-core/src/merge/validation.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/parallel/definition.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/parallel/executor.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/parallel/index.ts` | decl/reexport | yes | 0 |
| `packages/nodes-core/src/parallel/validation.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/policies.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/registrations.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/registry.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/schedule/definition.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/schedule/executor.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/schedule/index.ts` | decl/reexport | yes | 0 |
| `packages/nodes-core/src/schedule/validation.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/server-only.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/server.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/set/definition.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/set/executor.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/set/index.ts` | decl/reexport | yes | 0 |
| `packages/nodes-core/src/set/validation.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/switch/definition.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/switch/executor.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/switch/index.ts` | decl/reexport | yes | 0 |
| `packages/nodes-core/src/switch/validation.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/terminate/definition.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/terminate/executor.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/terminate/index.ts` | decl/reexport | yes | 0 |
| `packages/nodes-core/src/terminate/validation.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/validate/definition.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/validate/executor.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/validate/index.ts` | decl/reexport | yes | 0 |
| `packages/nodes-core/src/validate/issue-metadata.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/validate/semantics.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/validate/validation.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/wait/definition.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/wait/executor.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/wait/index.ts` | decl/reexport | yes | 0 |
| `packages/nodes-core/src/wait/validation.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/webhook/definition.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/webhook/executor.ts` | runtime | yes | 0 |
| `packages/nodes-core/src/webhook/index.ts` | decl/reexport | yes | 0 |
| `packages/nodes-core/src/webhook/validation.ts` | runtime | yes | 0 |
## Exact 239-row planning risk register

The following block is the planning register at the audited HEAD, preserved as
a historical tab-separated projection. It has nine tab-separated
columns and no header: source file, branch id, operand/index, syntax kind,
source line, source column, disposition, status, and rationale. The source file
contained 239 rows (SHA-256
`66f2c875afd23af297ff95fcf98cc7895394f6f60f089072d6ea9068b6633d5d`).

~~~tsv
packages/workflow-engine/src/advance-workflow.ts	7	0	cond-expr	92	12	defensive	reviewed-uncovered	Legacy checkpoints may carry the root join id instead of its canonical invocation key; this fallback normalizes only that validated root-compatible representation.
packages/workflow-engine/src/checkpoint-executable-validation.ts	12	1	if	0	0	generated	reviewed-uncovered	V8 reports this implicit join-validation fallthrough without a source location; canonical and legacy join decisions are exercised or reviewed at their concrete coordinates.
packages/workflow-engine/src/checkpoint-executable-validation.ts	2	1	cond-expr	37	8	defensive	reviewed-uncovered	A checkpoint join whose paired Parallel id is absent or non-string resolves to no executable Parallel and is rejected by the following identity guard.
packages/workflow-engine/src/checkpoint-executable-validation.ts	3	0	cond-expr	40	8	defensive	reviewed-uncovered	A missing paired Parallel produces no configured branch-id set, allowing the following identity guard to fail closed.
packages/workflow-engine/src/checkpoint-executable-validation.ts	4	0	if	42	2	defensive	reviewed-uncovered	This rejects a checkpoint join when its paired Parallel is absent or has no valid configured output-port set.
packages/workflow-engine/src/checkpoint-executable-validation.ts	6	0	if	50	2	defensive	reviewed-uncovered	This rejects a join ledger whose size or branch identifiers disagree with the paired Parallel definition.
packages/workflow-engine/src/checkpoint-executable-validation.ts	7	1	binary-expr	58	36	defensive	reviewed-uncovered	A legacy join without branchPath is normalized to the empty root scope solely for canonical invocation-key comparison.
packages/workflow-engine/src/checkpoint-executable-validation.ts	8	0	cond-expr	62	8	defensive	reviewed-uncovered	The canonical join-key input omits iterationPath only when the checkpoint join is not iteration scoped.
packages/workflow-engine/src/checkpoint-executable-validation.ts	9	0	if	65	2	defensive	reviewed-uncovered	The legacy root-join exception is considered only after the canonical join invocation-key comparison fails.
packages/workflow-engine/src/checkpoint-executable-validation.ts	10	0	binary-expr	67	6	defensive	reviewed-uncovered	The legacy root exception requires the stored invocation key to equal the join id.
packages/workflow-engine/src/checkpoint-executable-validation.ts	10	1	binary-expr	67	38	defensive	reviewed-uncovered	The legacy root exception requires an absent or empty branch path.
packages/workflow-engine/src/checkpoint-executable-validation.ts	10	2	binary-expr	68	41	defensive	reviewed-uncovered	An absent branch path is treated as empty only while checking the legacy root-join exception.
packages/workflow-engine/src/checkpoint-executable-validation.ts	11	0	binary-expr	69	7	defensive	reviewed-uncovered	The legacy root exception also requires an absent or empty iteration path.
packages/workflow-engine/src/checkpoint-executable-validation.ts	11	1	binary-expr	69	37	defensive	reviewed-uncovered	An absent iteration path is treated as empty only while checking the legacy root-join exception.
packages/workflow-engine/src/checkpoint-executable-validation.ts	12	0	if	70	4	defensive	reviewed-uncovered	This rejects a join invocation key that is neither canonical nor the narrowly accepted legacy root join id.
packages/workflow-engine/src/checkpoint-executable-validation.ts	25	1	binary-expr	144	71	unreachable	reviewed-uncovered	This expression runs only while iterating a defined iterationPath, so slicing it cannot need an undefined fallback.
packages/workflow-engine/src/checkpoint-shared.ts	39	1	if	0	0	generated	reviewed-uncovered	V8 reports this empty-location branch for an implicit fallthrough without a source location; the executable decision is tracked separately at its real source coordinate.
packages/workflow-engine/src/checkpoint-shared.ts	20	0	if	137	4	unreachable	reviewed-uncovered	The synchronous traversal proves the stack is non-empty immediately before pop, with no intervening mutation or asynchronous boundary.
packages/workflow-engine/src/checkpoint-v1-join.ts	7	1	cond-expr	51	6	defensive	reviewed-uncovered	An arrival count meeting the selected join policy has no unsatisfied reason; the opposite insufficient-arrivals outcome is covered through public join parsing and settlement tests.
packages/workflow-engine/src/checkpoint-v1-join.ts	16	1	binary-expr	100	47	defensive	reviewed-uncovered	A malformed count join without a numeric count receives the inert zero placeholder only until the immediately following checkpoint assertion rejects it.
packages/workflow-engine/src/checkpoint-v1.ts	8	0	if	45	2	unreachable	reviewed-uncovered	The public dispatcher enters the V1 parser only after proving schemaVersion is exactly 1.
packages/workflow-engine/src/checkpoint-v1.ts	16	1	binary-expr	174	12	defensive	reviewed-uncovered	The V1 checkpoint fallback reconstructs a canonical invocation key only for a legacy checkpoint that omitted it after the surrounding checkpoint identity fields have passed validation.
packages/workflow-engine/src/checkpoint-v2.ts	5	1	binary-expr	69	6	unreachable	reviewed-uncovered	Equal invocation keys identify the same node; duplicate selections are coalesced or rejected before sorting.
packages/workflow-engine/src/checkpoint.ts	5	1	if	0	0	generated	reviewed-uncovered	V8 reports this empty-location branch for an implicit fallthrough without a source location; the executable decision is tracked separately at its real source coordinate.
packages/workflow-engine/src/checkpoint.ts	6	0	cond-expr	34	31	defensive	reviewed-uncovered	When checkpoint parsing throws an Error, this branch preserves its sanitized message in the stable checkpoint_invalid boundary.
packages/workflow-engine/src/checkpoint.ts	6	1	cond-expr	34	47	defensive	reviewed-uncovered	When a dependency throws a non-Error value, this fallback prevents it escaping and emits the stable checkpoint parsing failed message.
packages/workflow-engine/src/coordinator-failures.ts	0	1	binary-expr	34	55	defensive	reviewed-uncovered	Failure derivation exhaustively maps validated scheduler control and invocation state; this residual operand protects against a missing invocation or distinguishes the already-tested canceled, deadline, and unknown-outcome terminal variants.
packages/workflow-engine/src/coordinator-failures.ts	1	0	if	35	4	defensive	reviewed-uncovered	A stale node-failure observation is ignored unless the matching invocation is still running at the same attempt number.
packages/workflow-engine/src/coordinator-failures.ts	4	0	if	43	4	defensive	reviewed-uncovered	Failure derivation exhaustively maps validated scheduler control and invocation state; this residual operand protects against a missing invocation or distinguishes the already-tested canceled, deadline, and unknown-outcome terminal variants.
packages/workflow-engine/src/coordinator-failures.ts	6	0	cond-expr	48	12	defensive	reviewed-uncovered	Failure derivation exhaustively maps validated scheduler control and invocation state; this residual operand protects against a missing invocation or distinguishes the already-tested canceled, deadline, and unknown-outcome terminal variants.
packages/workflow-engine/src/coordinator-failures.ts	6	1	cond-expr	49	12	defensive	reviewed-uncovered	Failure derivation exhaustively maps validated scheduler control and invocation state; this residual operand protects against a missing invocation or distinguishes the already-tested canceled, deadline, and unknown-outcome terminal variants.
packages/workflow-engine/src/coordinator-failures.ts	7	0	cond-expr	50	14	defensive	reviewed-uncovered	Failure derivation exhaustively maps validated scheduler control and invocation state; this residual operand protects against a missing invocation or distinguishes the already-tested canceled, deadline, and unknown-outcome terminal variants.
packages/workflow-engine/src/coordinator-failures.ts	7	1	cond-expr	51	14	defensive	reviewed-uncovered	Failure derivation exhaustively maps validated scheduler control and invocation state; this residual operand protects against a missing invocation or distinguishes the already-tested canceled, deadline, and unknown-outcome terminal variants.
packages/workflow-engine/src/coordinator-failures.ts	12	0	cond-expr	101	46	defensive	reviewed-uncovered	A retry-policy outcome_unknown decision is preserved; every other exhausted retry decision maps to failed.
packages/workflow-engine/src/coordinator-observations.ts	6	1	binary-expr	80	49	defensive	reviewed-uncovered	Observation derivation consumes validated executable and indexed durable state; this residual decision handles a missing correlated node/value/output, duplicate canonical material, optional durable scope, or deterministic ordering fallback without weakening transition semantics.
packages/workflow-engine/src/coordinator-observations.ts	7	0	if	81	4	defensive	reviewed-uncovered	Observation derivation consumes validated executable and indexed durable state; this residual decision handles a missing correlated node/value/output, duplicate canonical material, optional durable scope, or deterministic ordering fallback without weakening transition semantics.
packages/workflow-engine/src/coordinator-observations.ts	10	0	if	92	6	defensive	reviewed-uncovered	Observation derivation consumes validated executable and indexed durable state; this residual decision handles a missing correlated node/value/output, duplicate canonical material, optional durable scope, or deterministic ordering fallback without weakening transition semantics.
packages/workflow-engine/src/coordinator-observations.ts	14	0	if	114	4	defensive	reviewed-uncovered	Observation derivation consumes validated executable and indexed durable state; this residual decision handles a missing correlated node/value/output, duplicate canonical material, optional durable scope, or deterministic ordering fallback without weakening transition semantics.
packages/workflow-engine/src/coordinator-observations.ts	15	0	if	122	4	defensive	reviewed-uncovered	Observation derivation consumes validated executable and indexed durable state; this residual decision handles a missing correlated node/value/output, duplicate canonical material, optional durable scope, or deterministic ordering fallback without weakening transition semantics.
packages/workflow-engine/src/coordinator-observations.ts	17	1	cond-expr	143	10	unreachable	reviewed-uncovered	indexPersistedSuccessfulOutcomes receives facts from parsePersistedObservations and indexes only parsed succeeded outcomes, whose invocationKey is required to be a string; the undefined lookup arm cannot follow that production path.
packages/workflow-engine/src/coordinator-observations.ts	18	1	binary-expr	144	49	unreachable	reviewed-uncovered	parsePersistedObservations rejects a fresh outcome whose invocation is absent or stale before branchSelectionObservations receives the indexed successful outcomes; the missing-node fallback therefore cannot be selected by the public advance operation.
packages/workflow-engine/src/coordinator-observations.ts	26	0	if	206	4	defensive	reviewed-uncovered	Observation derivation consumes validated executable and indexed durable state; this residual decision handles a missing correlated node/value/output, duplicate canonical material, optional durable scope, or deterministic ordering fallback without weakening transition semantics.
packages/workflow-engine/src/coordinator-observations.ts	28	0	if	220	4	defensive	reviewed-uncovered	Observation derivation consumes validated executable and indexed durable state; this residual decision handles a missing correlated node/value/output, duplicate canonical material, optional durable scope, or deterministic ordering fallback without weakening transition semantics.
packages/workflow-engine/src/coordinator-observations.ts	29	1	binary-expr	226	49	defensive	reviewed-uncovered	Observation derivation consumes validated executable and indexed durable state; this residual decision handles a missing correlated node/value/output, duplicate canonical material, optional durable scope, or deterministic ordering fallback without weakening transition semantics.
packages/workflow-engine/src/coordinator-observations.ts	33	0	if	237	6	defensive	reviewed-uncovered	Observation derivation consumes validated executable and indexed durable state; this residual decision handles a missing correlated node/value/output, duplicate canonical material, optional durable scope, or deterministic ordering fallback without weakening transition semantics.
packages/workflow-engine/src/coordinator-observations.ts	34	0	if	245	4	defensive	reviewed-uncovered	Observation derivation consumes validated executable and indexed durable state; this residual decision handles a missing correlated node/value/output, duplicate canonical material, optional durable scope, or deterministic ordering fallback without weakening transition semantics.
packages/workflow-engine/src/coordinator-observations.ts	35	0	if	253	4	defensive	reviewed-uncovered	Observation derivation consumes validated executable and indexed durable state; this residual decision handles a missing correlated node/value/output, duplicate canonical material, optional durable scope, or deterministic ordering fallback without weakening transition semantics.
packages/workflow-engine/src/coordinator-observations.ts	37	0	if	274	4	defensive	reviewed-uncovered	Observation derivation consumes validated executable and indexed durable state; this residual decision handles a missing correlated node/value/output, duplicate canonical material, optional durable scope, or deterministic ordering fallback without weakening transition semantics.
packages/workflow-engine/src/coordinator-observations.ts	40	1	binary-expr	287	34	defensive	reviewed-uncovered	Observation derivation consumes validated executable and indexed durable state; this residual decision handles a missing correlated node/value/output, duplicate canonical material, optional durable scope, or deterministic ordering fallback without weakening transition semantics.
packages/workflow-engine/src/coordinator-observations.ts	50	1	binary-expr	341	42	defensive	reviewed-uncovered	Observation derivation consumes validated executable and indexed durable state; this residual decision handles a missing correlated node/value/output, duplicate canonical material, optional durable scope, or deterministic ordering fallback without weakening transition semantics.
packages/workflow-engine/src/coordinator-observations.ts	48	1	cond-expr	342	10	defensive	reviewed-uncovered	Observation derivation consumes validated executable and indexed durable state; this residual decision handles a missing correlated node/value/output, duplicate canonical material, optional durable scope, or deterministic ordering fallback without weakening transition semantics.
packages/workflow-engine/src/coordinator-observations.ts	55	1	binary-expr	345	43	defensive	reviewed-uncovered	Observation derivation consumes validated executable and indexed durable state; this residual decision handles a missing correlated node/value/output, duplicate canonical material, optional durable scope, or deterministic ordering fallback without weakening transition semantics.
packages/workflow-engine/src/coordinator-observations.ts	53	1	cond-expr	346	10	defensive	reviewed-uncovered	Observation derivation consumes validated executable and indexed durable state; this residual decision handles a missing correlated node/value/output, duplicate canonical material, optional durable scope, or deterministic ordering fallback without weakening transition semantics.
packages/workflow-engine/src/coordinator-observations.ts	59	0	if	366	4	defensive	reviewed-uncovered	Observation derivation consumes validated executable and indexed durable state; this residual decision handles a missing correlated node/value/output, duplicate canonical material, optional durable scope, or deterministic ordering fallback without weakening transition semantics.
packages/workflow-engine/src/coordinator-observations.ts	63	0	if	390	6	defensive	reviewed-uncovered	Observation derivation consumes validated executable and indexed durable state; this residual decision handles a missing correlated node/value/output, duplicate canonical material, optional durable scope, or deterministic ordering fallback without weakening transition semantics.
packages/workflow-engine/src/coordinator-observations.ts	65	0	cond-expr	399	12	defensive	reviewed-uncovered	Observation derivation consumes validated executable and indexed durable state; this residual decision handles a missing correlated node/value/output, duplicate canonical material, optional durable scope, or deterministic ordering fallback without weakening transition semantics.
packages/workflow-engine/src/coordinator-observations.ts	66	0	if	401	6	defensive	reviewed-uncovered	Observation derivation consumes validated executable and indexed durable state; this residual decision handles a missing correlated node/value/output, duplicate canonical material, optional durable scope, or deterministic ordering fallback without weakening transition semantics.
packages/workflow-engine/src/coordinator-observations.ts	79	0	cond-expr	472	20	defensive	reviewed-uncovered	Observation derivation consumes validated executable and indexed durable state; this residual decision handles a missing correlated node/value/output, duplicate canonical material, optional durable scope, or deterministic ordering fallback without weakening transition semantics.
packages/workflow-engine/src/coordinator-observations.ts	81	0	cond-expr	474	22	defensive	reviewed-uncovered	Observation derivation consumes validated executable and indexed durable state; this residual decision handles a missing correlated node/value/output, duplicate canonical material, optional durable scope, or deterministic ordering fallback without weakening transition semantics.
packages/workflow-engine/src/coordinator-output.ts	3	1	if	0	0	generated	reviewed-uncovered	V8 reports this empty-location branch for emitted control flow without a source coordinate; the corresponding executable decisions in this module are tracked at their real locations.
packages/workflow-engine/src/coordinator-output.ts	0	0	if	13	2	defensive	reviewed-uncovered	Coordinator output is an untrusted node boundary; the residual guard rejects a non-record JSON output before any output field is interpreted.
packages/workflow-engine/src/executable-compatibility.ts	0	0	if	20	4	unreachable	reviewed-uncovered	Compatibility releases are composed from validated canonical releases; this guard rejects engine-owned provider policy leakage or an impossible missing/mismatched adjacent release invariant.
packages/workflow-engine/src/executable-compatibility.ts	5	0	if	93	6	unreachable	reviewed-uncovered	Compatibility releases are composed from validated canonical releases; this guard rejects engine-owned provider policy leakage or an impossible missing/mismatched adjacent release invariant.
packages/workflow-engine/src/executable-compatibility.ts	8	0	if	104	6	unreachable	reviewed-uncovered	Compatibility releases are composed from validated canonical releases; this guard rejects engine-owned provider policy leakage or an impossible missing/mismatched adjacent release invariant.
packages/workflow-engine/src/executable-graph-boundary.ts	2	0	if	63	2	defensive	reviewed-uncovered	Executable graph input is untrusted; this residual branch rejects malformed node structure or preserves the explicit optional disabled/lifecycle representation before graph compilation.
packages/workflow-engine/src/executable-graph-boundary.ts	7	1	binary-expr	153	6	defensive	reviewed-uncovered	Executable graph input is untrusted; this residual branch rejects malformed node structure or preserves the explicit optional disabled/lifecycle representation before graph compilation.
packages/workflow-engine/src/executable-graph-boundary.ts	9	1	binary-expr	195	31	defensive	reviewed-uncovered	Executable graph input is untrusted; this residual branch rejects malformed node structure or preserves the explicit optional disabled/lifecycle representation before graph compilation.
packages/workflow-engine/src/executable-graph-boundary.ts	10	0	if	215	4	defensive	reviewed-uncovered	Executable graph input is untrusted; this residual branch rejects malformed node structure or preserves the explicit optional disabled/lifecycle representation before graph compilation.
packages/workflow-engine/src/executable-graph-boundary.ts	11	0	if	217	4	defensive	reviewed-uncovered	Executable graph input is untrusted; this residual branch rejects malformed node structure or preserves the explicit optional disabled/lifecycle representation before graph compilation.
packages/workflow-engine/src/executable-graph-boundary.ts	14	0	if	227	4	defensive	reviewed-uncovered	Executable graph input is untrusted; this residual branch rejects malformed node structure or preserves the explicit optional disabled/lifecycle representation before graph compilation.
packages/workflow-engine/src/executable-graph-boundary.ts	16	0	if	254	2	defensive	reviewed-uncovered	Executable graph input is untrusted; this residual branch rejects malformed node structure or preserves the explicit optional disabled/lifecycle representation before graph compilation.
packages/workflow-engine/src/executable-graph-rules.ts	0	0	if	30	2	defensive	reviewed-uncovered	Publication parses every graph definition against the same release before compilation, while compatibility verification parses both releases before lookup; this guard fails closed if either validated boundary contract regresses.
packages/workflow-engine/src/executable-graph-rules.ts	2	0	if	65	4	defensive	reviewed-uncovered	The graph boundary rejects edge endpoints that do not name declared nodes before the validation index is built; this duplicate source/target lookup guard prevents unsafe dereference if that prerequisite changes.
packages/workflow-engine/src/executable-graph-rules.ts	7	0	if	78	4	defensive	reviewed-uncovered	This publication-time contract check rejects a graph whose edge targets a port absent from the pinned target manifest; accepted fixtures cover the complementary valid-port path.
packages/workflow-engine/src/executable-graph-rules.ts	12	0	if	91	2	defensive	reviewed-uncovered	The node registry's versioned Switch config schema owns the cases-array requirement before publication; retaining only the default port here makes compilation fail closed if an unvalidated config reaches this lower layer.
packages/workflow-engine/src/executable-graph-rules.ts	13	0	if	94	6	defensive	reviewed-uncovered	Versioned Switch config validation excludes primitive, null, and array case entries; this lower-layer filter prevents malformed entries from becoming executable output ports.
packages/workflow-engine/src/executable-graph-rules.ts	15	1	cond-expr	97	45	defensive	reviewed-uncovered	Versioned Switch config validation requires every case id to be a string; the empty result is a fail-closed projection for callers that bypass the registry validation contract.
packages/workflow-engine/src/executable-graph-rules.ts	17	0	if	108	2	defensive	reviewed-uncovered	The node registry's versioned Parallel config schema owns the branches-array requirement; an absent or non-array value intentionally produces no executable branch ports in this lower layer.
packages/workflow-engine/src/executable-graph-rules.ts	18	0	if	110	4	defensive	reviewed-uncovered	Versioned Parallel config validation excludes primitive, null, and array branch entries; this lower-layer filter prevents malformed entries from becoming executable output ports.
packages/workflow-engine/src/executable-graph-rules.ts	20	1	cond-expr	113	43	defensive	reviewed-uncovered	Versioned Parallel config validation requires every branch id to be a string; the empty result is a fail-closed projection for callers that bypass the registry validation contract.
packages/workflow-engine/src/executable-graph-rules.ts	25	1	binary-expr	138	54	unreachable	reviewed-uncovered	graphValidationIndex seeds an adjacency entry for every declared node, and the graph boundary rejects undeclared edge sources; descendants is called only with those declared source or target node ids.
packages/workflow-engine/src/executable-graph-rules.ts	26	1	cond-expr	153	10	defensive	reviewed-uncovered	The pinned Merge config schema requires a string parallelNodeId; this fallback feeds the immediately following pairing assertion when an unvalidated Merge config reaches compilation.
packages/workflow-engine/src/executable-graph-rules.ts	27	0	if	154	4	defensive	reviewed-uncovered	This assertion rejects a Merge paired to a missing node, a non-Parallel node, or a different structured-definition version; valid direct and indirect Parallel/Merge pairings are covered.
packages/workflow-engine/src/executable-graph-rules.ts	30	0	if	164	4	defensive	reviewed-uncovered	This publication assertion rejects a configured Parallel branch without any outgoing edge; accepted fan-out and direct-to-Merge fixtures cover the complementary complete topology.
packages/workflow-engine/src/executable-graph-rules.ts	32	1	binary-expr	169	12	defensive	reviewed-uncovered	A missing node-port index entry is the expected representation of a Parallel branch with no outgoing edge and is consumed solely by the adjacent fail-closed assertion.
packages/workflow-engine/src/executable-graph-rules.ts	38	1	binary-expr	180	67	defensive	reviewed-uncovered	A missing incoming-node index entry represents a paired Merge with no incoming edges and is normalized to an empty list for the immediately following exact-input assertion.
packages/workflow-engine/src/executable-graph-rules.ts	39	0	if	181	6	defensive	reviewed-uncovered	This assertion rejects missing, duplicate, or foreign paired-Merge input ports; valid one-input-per-branch topologies are covered for every supported structured version.
packages/workflow-engine/src/executable-graph-rules.ts	41	0	if	194	6	defensive	reviewed-uncovered	The Merge config schema normally validates count policies; this lower-layer assertion independently prevents a malformed or excessive count from entering an executable.
packages/workflow-engine/src/executable-graph-rules.ts	42	3	binary-expr	198	9	defensive	reviewed-uncovered	A count-kind Merge with a nonnumeric count violates the pinned config schema; the branch is retained as independent fail-closed validation below that external schema seam.
packages/workflow-engine/src/executable-graph-rules.ts	42	4	binary-expr	199	11	defensive	reviewed-uncovered	A count larger than the paired Parallel branch set violates the pinned Merge contract; the explicit comparison protects compilation even if upstream config validation is bypassed.
packages/workflow-engine/src/executable-graph-rules.ts	45	0	if	213	4	defensive	reviewed-uncovered	This assertion rejects a paired Merge input fed from outside its corresponding Parallel branch ancestry; covered direct and traversing fixtures establish the valid reachability cases.
packages/workflow-engine/src/executable-validation.ts	17	0	if	88	4	defensive	reviewed-uncovered	The hostile executable JSON walker deliberately rejects this exact non-JSON, oversized, cyclic, accessor, sparse-array, symbol, prototype, Unicode, or policy-shape boundary before normalization.
packages/workflow-engine/src/executable-validation.ts	53	3	switch	241	4	defensive	reviewed-uncovered	The hostile executable JSON walker deliberately rejects this exact non-JSON, oversized, cyclic, accessor, sparse-array, symbol, prototype, Unicode, or policy-shape boundary before normalization.
packages/workflow-engine/src/graph-scheduler.ts	35	1	if	0	0	unreachable	reviewed-uncovered	A parsed checkpoint invocation key is derived from its workflow, node, branch, and iteration identity. Within one scheduler scope it is therefore a root identity, while an existing entry is replaced only by that same root; the implicit inconsistent-key arm requires bypassing checkpoint validation.
packages/workflow-engine/src/graph-scheduler.ts	40	1	if	0	0	unreachable	reviewed-uncovered	Validated structured graphs cannot reconverge two branch paths before their declared Merge boundary, and descendant marking stops at Merge nodes. A node therefore cannot first receive a longer path and later an equal or shorter competing path in one scheduling pass.
packages/workflow-engine/src/graph-scheduler.ts	4	0	if	52	2	defensive	reviewed-uncovered	Scheduling operates on a validated executable graph and durable invocation index; this residual decision handles an impossible missing graph relation or an optional branch/parallel path while preserving deterministic reachability and admission.
packages/workflow-engine/src/graph-scheduler.ts	6	0	if	59	2	defensive	reviewed-uncovered	Scheduling operates on a validated executable graph and durable invocation index; this residual decision handles an impossible missing graph relation or an optional branch/parallel path while preserving deterministic reachability and admission.
packages/workflow-engine/src/graph-scheduler.ts	7	1	cond-expr	63	8	defensive	reviewed-uncovered	Scheduling operates on a validated executable graph and durable invocation index; this residual decision handles an impossible missing graph relation or an optional branch/parallel path while preserving deterministic reachability and admission.
packages/workflow-engine/src/graph-scheduler.ts	9	0	if	65	2	defensive	reviewed-uncovered	Scheduling operates on a validated executable graph and durable invocation index; this residual decision handles an impossible missing graph relation or an optional branch/parallel path while preserving deterministic reachability and admission.
packages/workflow-engine/src/graph-scheduler.ts	21	1	cond-expr	124	6	defensive	reviewed-uncovered	Scheduling operates on a validated executable graph and durable invocation index; this residual decision handles an impossible missing graph relation or an optional branch/parallel path while preserving deterministic reachability and admission.
packages/workflow-engine/src/graph-scheduler.ts	25	0	if	176	4	defensive	reviewed-uncovered	Scheduling operates on a validated executable graph and durable invocation index; this residual decision handles an impossible missing graph relation or an optional branch/parallel path while preserving deterministic reachability and admission.
packages/workflow-engine/src/graph-scheduler.ts	28	1	binary-expr	179	46	defensive	reviewed-uncovered	Scheduling operates on a validated executable graph and durable invocation index; this residual decision handles an impossible missing graph relation or an optional branch/parallel path while preserving deterministic reachability and admission.
packages/workflow-engine/src/graph-scheduler.ts	36	1	binary-expr	240	34	defensive	reviewed-uncovered	Scheduling operates on a validated executable graph and durable invocation index; this residual decision handles an impossible missing graph relation or an optional branch/parallel path while preserving deterministic reachability and admission.
packages/workflow-engine/src/graph-scheduler.ts	37	0	cond-expr	257	27	defensive	reviewed-uncovered	Scheduling operates on a validated executable graph and durable invocation index; this residual decision handles an impossible missing graph relation or an optional branch/parallel path while preserving deterministic reachability and admission.
packages/workflow-engine/src/graph-scheduler.ts	48	1	binary-expr	322	66	defensive	reviewed-uncovered	Scheduling operates on a validated executable graph and durable invocation index; this residual decision handles an impossible missing graph relation or an optional branch/parallel path while preserving deterministic reachability and admission.
packages/workflow-engine/src/graph-scheduler.ts	52	1	binary-expr	353	64	defensive	reviewed-uncovered	Scheduling operates on a validated executable graph and durable invocation index; this residual decision handles an impossible missing graph relation or an optional branch/parallel path while preserving deterministic reachability and admission.
packages/workflow-engine/src/graph-scheduler.ts	62	1	binary-expr	399	47	unreachable	reviewed-uncovered	indexSchedulerGraph initializes a predecessor array for every graph node before readiness is derived, including isolated roots; the empty-array fallback guards only an internally inconsistent index.
packages/workflow-engine/src/node-attempt-input.ts	8	2	binary-expr	88	4	defensive	reviewed-uncovered	The optional nearest branch must exist before its node and output port can justify removing one branch scope from an upstream descriptor.
packages/workflow-engine/src/node-attempt-input.ts	7	0	cond-expr	89	8	defensive	reviewed-uncovered	Only an upstream descriptor sourced from the nearest matching branch uses its parent scope; all other descriptors retain the complete branch path.
packages/workflow-engine/src/node-attempt-input.ts	13	0	if	117	2	unreachable	reviewed-uncovered	Canonical JSON rejects undefined and exactKeys requires the descriptor value member.
packages/workflow-engine/src/node-attempt-input.ts	15	0	if	144	2	defensive	reviewed-uncovered	Iteration-scoped attempts cannot fall back to the root input object when no explicit descriptor resolves, preventing cross-iteration input leakage.
packages/workflow-engine/src/node-attempt-input.ts	24	0	if	196	2	unreachable	reviewed-uncovered	Normalized JSON arrays are dense and the preceding proof bounds the ordinal below array length.
packages/workflow-engine/src/node-attempt-input.ts	25	0	cond-expr	213	31	defensive	reviewed-uncovered	An Error thrown while validating attempt input contributes its sanitized message to the stable attempt_invalid operation error.
packages/workflow-engine/src/node-attempt-input.ts	25	1	cond-expr	213	47	defensive	reviewed-uncovered	A non-Error thrown while validating attempt input is converted to the stable attempt input is invalid fallback instead of escaping.
packages/workflow-engine/src/operations.ts	20	1	if	0	0	generated	reviewed-uncovered	V8 reports this empty-location branch for an implicit fallthrough without a source location; the executable decision is tracked separately at its real source coordinate.
packages/workflow-engine/src/operations.ts	3	1	binary-expr	111	37	unreachable	reviewed-uncovered	Recursive scheduler projection always materializes structuredBodies as an array.
packages/workflow-engine/src/operations.ts	16	0	if	337	4	unreachable	reviewed-uncovered	Object.keys enumerates present own keys on an immutable canonical executable mapping.
packages/workflow-engine/src/operations.ts	20	0	if	360	6	defensive	reviewed-uncovered	Mapping exceptions are translated at the operation boundary, with abort-like exceptions receiving the distinct attempt_aborted code.
packages/workflow-engine/src/operations.ts	21	0	binary-expr	360	10	defensive	reviewed-uncovered	An already-aborted signal classifies a thrown mapping failure as attempt_aborted even if the dependency did not create an AbortError.
packages/workflow-engine/src/operations.ts	21	1	binary-expr	360	28	defensive	reviewed-uncovered	A dependency AbortError classifies mapping failure as attempt_aborted even when signal observation races behind the throw.
packages/workflow-engine/src/operations.ts	22	0	if	364	4	defensive	reviewed-uncovered	A mapping result with error kind is inspected for cancellation before generic attempt_invalid conversion.
packages/workflow-engine/src/operations.ts	23	1	binary-expr	366	7	defensive	reviewed-uncovered	A mapping error carrying the canceled expression code is converted to attempt_aborted.
packages/workflow-engine/src/operations.ts	23	2	binary-expr	366	53	defensive	reviewed-uncovered	An aborted signal converts an otherwise generic mapping error result to attempt_aborted.
packages/workflow-engine/src/operations.ts	24	0	if	369	4	defensive	reviewed-uncovered	A non-cancellation mapping error result is converted to the stable attempt_invalid boundary.
packages/workflow-engine/src/operations.ts	26	0	if	404	4	unreachable	reviewed-uncovered	The parser receives exactly one preview node and either returns it or throws validation.
packages/workflow-engine/src/operations.ts	28	1	cond-expr	411	47	defensive	reviewed-uncovered	A non-Error thrown while parsing preview input uses the stable preview input is invalid fallback message.
packages/workflow-engine/src/operations.ts	31	0	if	453	4	defensive	reviewed-uncovered	A Merge node without coordinator-settled input is rejected before executing the merge definition.
packages/workflow-engine/src/output-reference.ts	4	1	if	0	0	generated	reviewed-uncovered	V8 reports a zero-coordinate phantom branch for the final output-reference mismatch return; public transition and scheduling tests exercise the real discriminant outcomes.
packages/workflow-engine/src/persisted-observations.ts	30	1	if	0	0	generated	reviewed-uncovered	V8 reports a zero-coordinate phantom branch after the extracted output-reference comparison; the executable persisted-observation paths cover the real source decisions.
packages/workflow-engine/src/persisted-observations.ts	3	0	if	110	6	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	4	1	cond-expr	123	47	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	5	0	if	132	2	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	7	0	if	138	2	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	8	0	if	140	2	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	9	0	binary-expr	142	6	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	9	1	binary-expr	143	6	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	9	2	binary-expr	144	6	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	9	3	binary-expr	145	6	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	9	4	binary-expr	146	6	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	10	0	if	148	2	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	11	0	binary-expr	150	6	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	11	1	binary-expr	151	6	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	11	2	binary-expr	152	6	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	11	3	binary-expr	153	6	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	11	4	binary-expr	154	6	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	11	5	binary-expr	155	6	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	11	6	binary-expr	156	6	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	11	7	binary-expr	157	6	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	11	8	binary-expr	158	7	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	13	0	binary-expr	158	7	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	13	1	binary-expr	158	41	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	12	0	cond-expr	159	10	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	12	1	cond-expr	160	10	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	14	0	binary-expr	160	10	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	14	1	binary-expr	160	39	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	15	0	if	162	2	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	17	0	if	177	2	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	18	0	if	179	2	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	19	0	binary-expr	182	8	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	19	1	binary-expr	183	8	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	20	0	if	186	2	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	21	0	binary-expr	191	6	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	21	1	binary-expr	192	6	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	21	2	binary-expr	193	6	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	21	3	binary-expr	194	6	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	22	5	binary-expr	210	10	defensive	reviewed-uncovered	A declared loop may reuse its pinned output only while waiting or after succeeding; other invocation states fail the persisted-observation consistency proof.
packages/workflow-engine/src/persisted-observations.ts	25	0	if	227	6	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	26	0	binary-expr	230	12	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	26	1	binary-expr	231	12	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	28	0	if	242	6	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	29	1	binary-expr	244	8	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	32	0	if	254	4	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	33	1	binary-expr	256	6	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	34	1	binary-expr	264	6	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	35	0	if	270	4	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/persisted-observations.ts	54	1	cond-expr	334	14	defensive	reviewed-uncovered	The persisted fact window is normalized before transition; this residual decision enforces fact size/identity, duplicate consistency, optional output equality, terminal-state correlation, or deterministic ordering for malformed or repeated durable facts.
packages/workflow-engine/src/scheduling.ts	0	0	if	40	2	defensive	reviewed-uncovered	The public scheduling primitive validates limits and reconciles a complete disposition ledger; this residual operand protects invalid capacity/state or an already-covered terminal disposition and active-ordinal invariant.
packages/workflow-engine/src/scheduling.ts	4	0	if	55	4	defensive	reviewed-uncovered	The public scheduling primitive validates limits and reconciles a complete disposition ledger; this residual operand protects invalid capacity/state or an already-covered terminal disposition and active-ordinal invariant.
packages/workflow-engine/src/scheduling.ts	5	0	if	58	4	defensive	reviewed-uncovered	The public scheduling primitive validates limits and reconciles a complete disposition ledger; this residual operand protects invalid capacity/state or an already-covered terminal disposition and active-ordinal invariant.
packages/workflow-engine/src/scheduling.ts	10	0	if	80	2	defensive	reviewed-uncovered	The public scheduling primitive validates limits and reconciles a complete disposition ledger; this residual operand protects invalid capacity/state or an already-covered terminal disposition and active-ordinal invariant.
packages/workflow-engine/src/scheduling.ts	17	0	if	143	2	defensive	reviewed-uncovered	The public scheduling primitive validates limits and reconciles a complete disposition ledger; this residual operand protects invalid capacity/state or an already-covered terminal disposition and active-ordinal invariant.
packages/workflow-engine/src/scheduling.ts	19	0	if	150	4	defensive	reviewed-uncovered	The public scheduling primitive validates limits and reconciles a complete disposition ledger; this residual operand protects invalid capacity/state or an already-covered terminal disposition and active-ordinal invariant.
packages/workflow-engine/src/scheduling.ts	28	0	if	192	2	defensive	reviewed-uncovered	The public scheduling primitive validates limits and reconciles a complete disposition ledger; this residual operand protects invalid capacity/state or an already-covered terminal disposition and active-ordinal invariant.
packages/workflow-engine/src/scheduling.ts	31	0	if	223	2	defensive	reviewed-uncovered	The public scheduling primitive validates limits and reconciles a complete disposition ledger; this residual operand protects invalid capacity/state or an already-covered terminal disposition and active-ordinal invariant.
packages/workflow-engine/src/transition-decisions.ts	3	1	binary-expr	36	68	unreachable	reviewed-uncovered	Checkpoint/executable validation guarantees every branchPath node is present in the scheduler's root or structured-body index before admission decisions run; the empty object only preserves a total helper contract.
packages/workflow-engine/src/transition-decisions.ts	7	0	if	45	6	defensive	reviewed-uncovered	Checkpoint validation normally proves that a nested Parallel branch carries its containing loop scope; this explicit error prevents a malformed internal checkpoint from sharing capacity across iterations.
packages/workflow-engine/src/transition-decisions.ts	9	1	binary-expr	54	34	unreachable	reviewed-uncovered	constraints is entered only while iterating an existing branchPath, and the invocation is immutable during the synchronous calculation; branchPath therefore cannot become absent before its prefix is encoded.
packages/workflow-engine/src/transition-decisions.ts	13	0	if	73	4	unreachable	reviewed-uncovered	The transition planner derives readySet from the same validated invocation collection passed here and does not mutate it during admission; every ready key consequently exists in invocationByKey.
packages/workflow-engine/src/workflow-transition-derived.ts	21	1	if	0	0	generated	reviewed-uncovered	V8 reports this empty-location branch for emitted control flow without a source coordinate; the corresponding executable decisions in this module are tracked at their real locations.
packages/workflow-engine/src/workflow-transition-derived.ts	3	0	if	44	4	defensive	reviewed-uncovered	Derived transition state is built from validated graph, checkpoint, and scheduler decisions; this residual guard preserves legacy loop compatibility or rejects a missing/duplicate parent, invocation, body, or iteration invariant.
packages/workflow-engine/src/workflow-transition-derived.ts	8	0	if	82	4	defensive	reviewed-uncovered	Derived transition state is built from validated graph, checkpoint, and scheduler decisions; this residual guard preserves legacy loop compatibility or rejects a missing/duplicate parent, invocation, body, or iteration invariant.
packages/workflow-engine/src/workflow-transition-derived.ts	9	1	binary-expr	82	30	defensive	reviewed-uncovered	Derived transition state is built from validated graph, checkpoint, and scheduler decisions; this residual guard preserves legacy loop compatibility or rejects a missing/duplicate parent, invocation, body, or iteration invariant.
packages/workflow-engine/src/workflow-transition-derived.ts	10	0	if	83	4	defensive	reviewed-uncovered	Derived transition state is built from validated graph, checkpoint, and scheduler decisions; this residual guard preserves legacy loop compatibility or rejects a missing/duplicate parent, invocation, body, or iteration invariant.
packages/workflow-engine/src/workflow-transition-derived.ts	11	1	cond-expr	98	65	defensive	reviewed-uncovered	Derived transition state is built from validated graph, checkpoint, and scheduler decisions; this residual guard preserves legacy loop compatibility or rejects a missing/duplicate parent, invocation, body, or iteration invariant.
packages/workflow-engine/src/workflow-transition-derived.ts	12	1	binary-expr	107	45	defensive	reviewed-uncovered	Derived transition state is built from validated graph, checkpoint, and scheduler decisions; this residual guard preserves legacy loop compatibility or rejects a missing/duplicate parent, invocation, body, or iteration invariant.
packages/workflow-engine/src/workflow-transition-derived.ts	17	0	cond-expr	143	10	defensive	reviewed-uncovered	Derived transition state is built from validated graph, checkpoint, and scheduler decisions; this residual guard preserves legacy loop compatibility or rejects a missing/duplicate parent, invocation, body, or iteration invariant.
packages/workflow-engine/src/workflow-transition-derived.ts	19	0	if	146	4	defensive	reviewed-uncovered	Derived transition state is built from validated graph, checkpoint, and scheduler decisions; this residual guard preserves legacy loop compatibility or rejects a missing/duplicate parent, invocation, body, or iteration invariant.
packages/workflow-engine/src/workflow-transition-derived.ts	22	0	if	171	4	defensive	reviewed-uncovered	Derived transition state is built from validated graph, checkpoint, and scheduler decisions; this residual guard preserves legacy loop compatibility or rejects a missing/duplicate parent, invocation, body, or iteration invariant.
packages/workflow-engine/src/workflow-transition-derived.ts	25	0	if	200	2	defensive	reviewed-uncovered	Derived transition state is built from validated graph, checkpoint, and scheduler decisions; this residual guard preserves legacy loop compatibility or rejects a missing/duplicate parent, invocation, body, or iteration invariant.
packages/workflow-engine/src/workflow-transition-derived.ts	27	0	if	213	9	defensive	reviewed-uncovered	Derived transition state is built from validated graph, checkpoint, and scheduler decisions; this residual guard preserves legacy loop compatibility or rejects a missing/duplicate parent, invocation, body, or iteration invariant.
packages/workflow-engine/src/workflow-transition-derived.ts	31	0	if	258	8	defensive	reviewed-uncovered	Derived transition state is built from validated graph, checkpoint, and scheduler decisions; this residual guard preserves legacy loop compatibility or rejects a missing/duplicate parent, invocation, body, or iteration invariant.
packages/workflow-engine/src/workflow-transition-derived.ts	33	0	cond-expr	271	23	defensive	reviewed-uncovered	Derived transition state is built from validated graph, checkpoint, and scheduler decisions; this residual guard preserves legacy loop compatibility or rejects a missing/duplicate parent, invocation, body, or iteration invariant.
packages/workflow-engine/src/workflow-transition-observations.ts	4	1	if	0	0	generated	reviewed-uncovered	V8 reports this empty-location branch for an implicit fallthrough without a source location; the executable decision is tracked separately at its real source coordinate.
packages/workflow-engine/src/workflow-transition-observations.ts	36	1	if	0	0	generated	reviewed-uncovered	V8 emitted this implicit fallthrough branch without a source coordinate; the adjacent executable decision is covered through the public workflow transition interface.
packages/workflow-engine/src/workflow-transition-observations.ts	63	1	if	0	0	generated	reviewed-uncovered	V8 reports this empty-location branch for an implicit fallthrough without a source location; the executable decision is tracked separately at its real source coordinate.
packages/workflow-engine/src/workflow-transition-observations.ts	64	1	if	0	0	generated	reviewed-uncovered	V8 reports this empty-location branch for an implicit fallthrough without a source location; the executable decision is tracked separately at its real source coordinate.
packages/workflow-engine/src/workflow-transition-observations.ts	9	0	cond-expr	81	8	unreachable	reviewed-uncovered	declaredJoin always materializes joinInvocationKey before branch dispositions can be applied.
packages/workflow-engine/src/workflow-transition-observations.ts	18	0	binary-expr	130	6	unreachable	reviewed-uncovered	A valid invocation key identifies one node and duplicate selection pairs return or reject before sorting.
packages/workflow-engine/src/workflow-transition-observations.ts	18	1	binary-expr	131	6	unreachable	reviewed-uncovered	The node comparator requires equal invocation keys, which necessarily refer to the same validated node.
packages/workflow-engine/src/workflow-transition-observations.ts	22	1	binary-expr	155	4	defensive	reviewed-uncovered	A loop declaration that omits controlInvocationKey derives the canonical root control key from workflow version and loop id.
packages/workflow-engine/src/workflow-transition-observations.ts	25	0	if	181	4	defensive	reviewed-uncovered	Only loop_limit_exceeded is converted into loop terminal state; every other WorkflowEngineError and foreign exception is rethrown.
packages/workflow-engine/src/workflow-transition-observations.ts	27	0	if	187	4	defensive	reviewed-uncovered	A loop-limit observation requires an existing running control invocation before it may mark that controller failed.
packages/workflow-engine/src/workflow-transition-observations.ts	39	0	if	276	7	defensive	reviewed-uncovered	A repeated loop completion with a conflicting terminal status is rejected through the normal node-transition invariant.
packages/workflow-engine/src/workflow-transition-observations.ts	40	1	cond-expr	281	48	defensive	reviewed-uncovered	Loop completion omits the output property when the observation carries no output, preserving absent-versus-present state semantics.
packages/workflow-engine/src/workflow-transition-observations.ts	46	0	if	300	4	defensive	reviewed-uncovered	Completing all loop iterations requires an existing non-terminal control invocation; missing or already-terminal control state fails closed.
packages/workflow-engine/src/workflow-transition-observations.ts	48	1	binary-expr	310	33	unreachable	reviewed-uncovered	Every admitted non-success loop terminal status has a node event mapping.
packages/workflow-engine/src/workflow-transition-observations.ts	49	0	if	318	2	unreachable	reviewed-uncovered	The closed WorkflowObservation terminal-status union has a nodeEventName entry for every member.
packages/workflow-engine/src/workflow-transition-observations.ts	54	1	cond-expr	347	10	defensive	reviewed-uncovered	A node-ready observation that omits branchPath preserves omission instead of materializing an empty scope.
packages/workflow-engine/src/workflow-transition-observations.ts	55	1	cond-expr	350	10	defensive	reviewed-uncovered	A node-ready observation that omits iterationPath preserves omission instead of materializing an empty iteration scope.
packages/workflow-engine/src/workflow-transition-observations.ts	58	1	cond-expr	371	10	defensive	reviewed-uncovered	A successful node observation without output leaves the output property absent rather than storing undefined.
packages/workflow-engine/src/workflow-transition-observations.ts	71	0	if	423	2	unreachable	reviewed-uncovered	The closed WorkflowObservation terminal-status union has a nodeEventName entry for every member.
packages/workflow-engine/src/workflow-transition-plan.ts	2	0	if	59	4	unreachable	reviewed-uncovered	Plan construction receives invocation keys selected from the current validated transition state; the missing-invocation guard is retained as fail-closed corruption protection.
packages/workflow-engine/src/workflow-transition-plan.ts	14	0	if	160	6	unreachable	reviewed-uncovered	Plan construction receives invocation keys selected from the current validated transition state; the missing-invocation guard is retained as fail-closed corruption protection.
packages/workflow-engine/src/workflow-transition-state.ts	9	1	binary-expr	120	56	defensive	reviewed-uncovered	A scoped join may supply an explicit invocation key; otherwise the validated root join identifier is the compatibility default.
packages/workflow-engine/src/workflow-transition-state.ts	16	0	if	192	2	defensive	reviewed-uncovered	Attempt admission fails closed when a ready node is absent from the supplied scheduler graph.
packages/workflow-engine/src/workflow-transition-state.ts	17	0	if	204	2	defensive	reviewed-uncovered	Without scheduler state, disabled-node lookup deliberately returns false while later admission requires the graph and fails closed.
packages/workflow-engine/src/workflow-transition-state.ts	18	1	binary-expr	208	76	defensive	reviewed-uncovered	Scheduler states without structuredBodies search only root nodes; the optional collection fallback prevents iteration over absent nested bodies.
packages/workflow-engine/src/workflow-transition-state.ts	21	0	if	245	4	unreachable	reviewed-uncovered	The public checkpoint parser verifies every active loop ordinal has a matching invocation before transition state reaches this secondary invariant check.
packages/workflow-engine/src/workflow-transition-state.ts	24	0	if	273	4	unreachable	reviewed-uncovered	The public checkpoint parser verifies every terminal loop ordinal has a terminal invocation before transition state reaches this secondary invariant check.
packages/workflow-engine/src/workflow-transition-stops.ts	5	0	if	39	6	defensive	reviewed-uncovered	Stop propagation consumes validated loop and invocation state; this residual decision preserves legacy-loop compatibility or exhaustively selects terminal, timed-out, canceled, and fallback event semantics.
packages/workflow-engine/src/workflow-transition-stops.ts	7	0	if	51	10	defensive	reviewed-uncovered	Stop propagation consumes validated loop and invocation state; this residual decision preserves legacy-loop compatibility or exhaustively selects terminal, timed-out, canceled, and fallback event semantics.
packages/workflow-engine/src/workflow-transition-stops.ts	9	0	if	71	8	defensive	reviewed-uncovered	Stop propagation consumes validated loop and invocation state; this residual decision preserves legacy-loop compatibility or exhaustively selects terminal, timed-out, canceled, and fallback event semantics.
packages/workflow-engine/src/workflow-transition-stops.ts	10	0	if	78	6	defensive	reviewed-uncovered	Stop propagation consumes validated loop and invocation state; this residual decision preserves legacy-loop compatibility or exhaustively selects terminal, timed-out, canceled, and fallback event semantics.
packages/workflow-engine/src/workflow-transition-stops.ts	14	1	binary-expr	90	54	defensive	reviewed-uncovered	Stop propagation consumes validated loop and invocation state; this residual decision preserves legacy-loop compatibility or exhaustively selects terminal, timed-out, canceled, and fallback event semantics.
packages/workflow-engine/src/workflow-transition-stops.ts	16	1	cond-expr	102	19	defensive	reviewed-uncovered	Stop propagation consumes validated loop and invocation state; this residual decision preserves legacy-loop compatibility or exhaustively selects terminal, timed-out, canceled, and fallback event semantics.
packages/workflow-engine/src/workflow-transition-stops.ts	17	0	binary-expr	102	19	defensive	reviewed-uncovered	Stop propagation consumes validated loop and invocation state; this residual decision preserves legacy-loop compatibility or exhaustively selects terminal, timed-out, canceled, and fallback event semantics.
packages/workflow-engine/src/workflow-transition-stops.ts	17	1	binary-expr	102	52	defensive	reviewed-uncovered	Stop propagation consumes validated loop and invocation state; this residual decision preserves legacy-loop compatibility or exhaustively selects terminal, timed-out, canceled, and fallback event semantics.
packages/workflow-engine/src/workflow-transition-stops.ts	22	1	cond-expr	123	13	defensive	reviewed-uncovered	Stop propagation consumes validated loop and invocation state; this residual decision preserves legacy-loop compatibility or exhaustively selects terminal, timed-out, canceled, and fallback event semantics.
packages/workflow-engine/src/workflow-transition-stops.ts	23	1	cond-expr	136	61	defensive	reviewed-uncovered	Stop propagation consumes validated loop and invocation state; this residual decision preserves legacy-loop compatibility or exhaustively selects terminal, timed-out, canceled, and fallback event semantics.
~~~
