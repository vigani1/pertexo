# Workflow engine/model structural inventory

Date: 2026-09-12. This is a read-only structural audit of the current source
tree. It records all 50 `packages/workflow-engine/src` files and all 22
`packages/workflow-model/src` files (72 files, 12,114 lines) exactly once.
Existing uncommitted user changes were preserved. No runtime source, test,
coverage configuration, migration, or service file was changed.

The review used the codebase-design vocabulary: a **module** has an
**interface**, a **seam** is where that interface lives, an **adapter** fills a
seam, and a deep module hides substantial behavior behind a small interface.
`KEEP` means the current seam/locality is justified. `SIMPLIFY` means a small
behavior-preserving reduction is supported by current callers. `SPLIT` means
there are independently changing owners that can be separated behind the
existing facade. `INVESTIGATE` means there is a concrete observation requiring
measurement or a focused contract proof; it is not implementation
authorization.

## Findings supported by current evidence

### PF-05 — waiting cancellation loses to simultaneous deadline (P1, Fix)

Location: `packages/workflow-engine/src/workflow-transition-stops.ts:26-35`
and `:111-164`. The first pass chooses `canceled` when both flags are true,
but the ordinary invocation deadline pass changes every waiting invocation to
`timed_out`; the later cancellation pass only visits still nonterminal
invocations. `packages/workflow-engine/src/workflow-transition-observations.ts:440-447`
sets both facts. `packages/workflow-engine/src/transition-decisions.ts:94-99`
then correctly gives the run `canceled`, leaving node/run state inconsistent.

The [primary reproduction](post-fix-follow-up-audit.md#pf-05--waiting-node-cancellation-loses-to-simultaneous-deadline)
used the existing `dist/testing.js` V2 constructor and transition interface,
admitted a safe invocation, and obtained its waiting checkpoint through a real
`wait` observation. No checkpoint or branded executable was mutated. Applying
both controls next produced invocation `timed_out`, run `canceled`, and events
`run.cancel_requested`, `node.timed_out`, `run.canceled`, without new admissions.
Production `operations.ts:171-225` passes controls to the same transition core;
an authentic compiled-executable regression and database-backed integration
remain acceptance work, not evidence claimed here.

This contradicts ADR 021, `docs/adr/021-durable-wait.md:50-58`, which requires
a committed cancellation to win for a purely waiting safe invocation when both
controls are first observed. Minimal scope is one unified stop-precedence pass
for ordinary and scoped invocations. Preserve `outcome_unknown` precedence,
leave running effects for reconciliation, do not resume work, and keep
checkpoint/event sequencing unchanged otherwise.

Acceptance: authentic compiled-executable regression through production
`advanceWorkflow`, both fact orders, cancellation-only, deadline-only, scoped
wait, already-terminal nodes, active running attempts, unsafe possible dispatch,
and no retained `resumeAt`/`waitKind` or admission. Expected simultaneous result
is node canceled + run canceled with no `node.timed_out`.

### WF-S01 — dead cancellation-decision variant (P3, Simplify candidate)

`packages/workflow-engine/src/runtime.ts:36` includes
`CancellationDecision.kind = stop_scheduling`, but
`decideCancellation` at `:47-72` only returns `outcome_unknown`,
`await_reconciliation`, or `canceled`. A caller grep across `packages/` and
`apps/` finds the helper exported only through the testing facade
(`packages/workflow-engine/src/testing.ts:78`) and referenced by tests; no
production adapter consumes or returns `stop_scheduling`. This is a shallow
public-test seam cleanup, not a production transition defect.

Minimal scope is to remove the dead union member if the supported testing
contract permits the type narrowing, or retain it with a documented existing
compatibility reason. Do not invent a production caller to justify it.
Preserve cancellation precedence, unsafe-dispatch reconciliation,
and the production transition engine.

Acceptance: type-check and the exact `packages/workflow-engine/test/retry-wait-cancellation.test.ts`,
`packages/workflow-engine/test/expanded-public-boundary-coverage.test.ts`, and
`packages/workflow-engine/test/executable-workflow-foreach-part-2.test.ts`
public-boundary assertions pass, with no `stop_scheduling` value remaining
unless its new contract is tested.

### PF-06 — repeated workflow indexing/scans (P3, Conditional)

The current implementation has several concrete repeated-work sites, but no
latency regression has been measured. `coordinator-observations.ts:375-380`
copies the accumulated per-node successful-invocation array on every insertion;
`coordinator-observations.ts:312-318` scans checkpoint invocations for each
active loop ordinal; `:432-467` repeatedly searches edges and scans projected
invocations for each merge branch. `workflow-transition-state.ts:179-211`
rebuilds root/structured node arrays and linearly searches them on each
side-effect/disabled lookup; callers include
`workflow-transition-plan.ts:84,168` and
`workflow-transition-derived.ts:267`. `node-attempt-input.ts:65-200` and
`checkpoint-executable-validation.ts:95-207` also repeat bounded graph/scope
lookups on separate paths.

Minimal scope is a private, per-advance prepared index (nodes, edges, scopes,
and successful facts), or at minimum mutable local group accumulation. It must
not mutate durable checkpoints or become a cross-run cache. Preserve map/array
ordering, duplicate/conflict behavior, stale-loop and merge semantics,
missing-node fail-closed behavior, disabled nodes, side-effect classes, and
scope-prefix matching.

Acceptance is a byte/equality characterization against current plans, events,
admission classes, and errors for duplicate/conflicting facts, nested scopes,
stale loops, joins, merges, and missing nodes, plus a repeatable representative
and configured-limit benchmark showing lower repeated work without material
memory growth. Retain the current implementation if measurement does not pay
for the extra seam.

### PF-07 — evaluator context accessor hardening candidate (P3, Contract
investigation)

`packages/workflow-model/src/expressions/policy.ts:313-329` canonicalizes the
two exposed values before worker handoff, and
`packages/workflow-model/src/expressions/evaluator.ts:88-105` catches any
canonicalization error before queue admission. A no-worker probe with a
throwing own `runInput` getter observed one host-side getter execution, an
`evaluation_failed` result carrying `getter-ran`, and zero worker creations.
The worker-isolation promise therefore holds; the observation is an optional
host-side hardening opportunity, not a demonstrated production contract
violation or HTTP exploit.

Actual production callers pass canonical JSON (`operations.ts`, API node
testing validation, and worker preview/attempt runtimes), so this is not a
claim of an HTTP exploit. The public `ExpressionEvaluator` seam is nevertheless
used directly by tests and injected adapters, and `evaluate` receives a typed
context while the implementation deliberately accepts unknown runtime values.
If the public evaluator contract should guarantee no accessor invocation,
minimal scope is descriptor-based extraction/rejection of the two top-level
fields before reading values, or an explicit contract clarification that
hostile runtime objects are outside the evaluator seam. Preserve normal
context behavior, stable error typing, worker isolation, and any agreed
no-getter guarantee.

Acceptance if hardened: hostile top-level and nested accessor contexts never
execute an accessor and return the agreed stable failure; worker factory
remains unused; canonical JSON contexts, limits, cancellation, and evaluator
lifecycle tests remain unchanged. Do not change graph normalization or
accepted JSON semantics as part of PF-07.

No graph-array-extra finding is promoted here: browser/server graph callers
operate on parsed JSON/normalization contracts, and current evidence does not
establish a caller violation or required exact-array-property semantics.

## Complete file ledger

The test column names the closest existing behavior suite; it is evidence of
the current seam, not a claim that every branch is covered. A bare suite name
resolves to the exact same-package path
`packages/<package>/test/<suite>.test.ts` (for example,
`packages/workflow-engine/test/checkpoint-seam.test.ts` or
`packages/workflow-model/test/expressions.test.ts`). Cross-package groups
named in prose expand to these exact files: API node-testing is
`apps/api/test/node-testing/{controller,errors,module,use-case,validation}.test.ts`;
API workflow authoring is
`apps/api/test/workflow-authoring/{graph,preconditions,use-cases}.test.ts` plus
`apps/api/test/workflow-authoring/{lifecycle,version-restore}.integration.test.ts`;
database workflow authoring is
`packages/database/test/workflow-authoring*.test.ts` (the focused
`workflow-authoring.test.ts` and the named `*.integration.test.ts` variants);
and trigger/lifecycle persistence is the relevant
`packages/database/test/*trigger*.test.ts`,
`packages/database/test/connections-lifecycle.integration.test.ts`, or
`packages/database/test/execution-acceptance-lifecycle.integration.test.ts`.
`PF-05`–`PF-07` and `WF-S01` are the current concrete candidates assigned in
this inventory; PF-07 remains conditional on the public no-getter contract.

### `packages/workflow-engine/src` (50 files)

| File | Lines | Role | Interface, caller-specific reason, and disposition | Relevant tests / findings |
|---|---:|---|---|---|
| `packages/workflow-engine/src/advance-workflow.ts` | 142 | KEEP | Small deterministic orchestration seam: validates cursor/admission arithmetic, initializes mutable state, orders facts, then applies/derives/stops/builds. Called by the testing facade and production operation. | `advance-workflow-transitions`, `advance-workflow-risk-branches`, `serialized-boundary-matrices`; no finding |
| `packages/workflow-engine/src/checkpoint-executable-validation.ts` | 240 | KEEP | One executable/checkpoint identity proof over joins, invocations, scopes, and loops. Production `operations.ts` calls it after both values are parsed; splitting would scatter identity invariants. | `executable-workflow-identity`, `serialized-boundary-matrices`; no finding |
| `packages/workflow-engine/src/checkpoint-identity.ts` | 36 | KEEP | Shared persisted engine/version/timestamp primitive used by checkpoint parsers and constructors; one small owner keeps DB-compatible formats local. | `checkpoint-seam`, `checkpoint-risk-branches`; no finding |
| `packages/workflow-engine/src/checkpoint-shared.ts` | 478 | KEEP | Bounded hostile JSON traversal plus shared invocation, scope, output, ledger, and sorting grammar. Parser callers depend on fail-closed reflection and exact durable state; size is cohesive. | `checkpoint-seam`, `checkpoint-risk-branches`; no finding |
| `packages/workflow-engine/src/checkpoint-v1-join.ts` | 193 | KEEP | Atomic V1 join grammar: policy/count, ledger, selection, settlement, and unsatisfied reason invariants belong together. | `checkpoint-seam`, `branch-join-scheduling`; no finding |
| `packages/workflow-engine/src/checkpoint-v1-loop.ts` | 198 | KEEP | Atomic V1 loop grammar for collection identity, topology, bounds, cursors, and ordinal accounting. | `checkpoint-seam`, `foreach-scheduling`; no finding |
| `packages/workflow-engine/src/checkpoint-v1.ts` | 289 | KEEP | V1 top-level parser owns sorting, duplicate keys, ready reconstruction, parent consistency, legacy synthetic loops, and wait metadata. | `checkpoint-seam`, `checkpoint-risk-branches`; no finding |
| `packages/workflow-engine/src/checkpoint-v2.ts` | 143 | KEEP | Additive V2 parser reuses V1 semantics while binding structured scopes and branch selections; this is persisted compatibility, not accidental duplication. | `checkpoint-seam`, `foreach-scheduling`, `serialized-boundary-matrices`; no finding |
| `packages/workflow-engine/src/checkpoint.ts` | 100 | KEEP | Public dispatch/create/reconstruct seam for V1/V2; callers get stable `WorkflowEngineError` classification. | `checkpoint-seam`, `checkpoint-risk-branches`; no finding |
| `packages/workflow-engine/src/coordinator-failures.ts` | 106 | KEEP | Converts validated attempt failures plus pinned retry policy into semantic observations; production `operations.ts` supplies node/checkpoint maps. | `executable-workflow-outcomes`, `retry-wait-cancellation`, `operation-risk-branches`; no finding |
| `packages/workflow-engine/src/coordinator-observations.ts` | 500 | INVESTIGATE | Owns branch, For Each, and Parallel/Merge derived facts. Its callers require exact persisted outcome/material correlation; repeated grouping/filter/find work is PF-06. | `executable-workflow-branching`, `executable-workflow-foreach`, `parallel-output-assurance`, `operation-risk-branches`; PF-06 |
| `packages/workflow-engine/src/coordinator-output.ts` | 62 | KEEP | Small completed-output reference/parser/index seam; production operation and coordinator derivation share its durable locator rules. | `executable-workflow-outcomes`, `parallel-output-assurance`; no finding |
| `packages/workflow-engine/src/core-definition-identities.ts` | 41 | KEEP | Closed core-definition predicates centralize Merge/Parallel/Schedule/trigger identity checks used across graph and transition owners. | `executable-workflow-identity`, `scheduler-projection`; no finding |
| `packages/workflow-engine/src/errors.ts` | 24 | KEEP | Stable closed engine error interface; callers branch on code while messages remain diagnostic. | `package-contract`, broad engine suites; no finding |
| `packages/workflow-engine/src/executable-boundary.ts` | 138 | KEEP | Raw executable envelope parse/verify seam combines provenance, policy, graph, pin, freeze, and checksum proof before authenticity registration. | `executable-workflow-identity`, `serialized-boundary-matrices`; no finding |
| `packages/workflow-engine/src/executable-compatibility.ts` | 130 | KEEP | Compatibility-release composition/history/resolve seam protects rolling overlap and retained history; production release setup is its caller. | `executable-workflow-identity`, `expanded-public-boundary-coverage`; no finding |
| `packages/workflow-engine/src/executable-compilation.ts` | 160 | KEEP | Compiles validated model graph into pinned executable identity; manifest, port, reconvergence, policy, and checksum sequencing is one publication owner. | `executable-workflow-identity`, `executable-workflow-branching`; no finding |
| `packages/workflow-engine/src/executable-foundation.ts` | 191 | KEEP | Defines immutable executable vocabulary, authenticity brand, freeze, digest, identity comparison, and baseline policies. Many boundary/compiler callers rely on these exact invariants. | `executable-workflow-identity`, `package-contract`; no finding |
| `packages/workflow-engine/src/executable-graph-boundary.ts` | 260 | KEEP | Separates untrusted executable graph shape from authoring-model validation and runtime pin checks. `executable-boundary.ts` is the caller; dropping executable-only fields here is intentional. | `executable-workflow-identity`, `serialized-boundary-matrices`; no finding |
| `packages/workflow-engine/src/executable-graph-rules.ts` | 255 | KEEP | Publication topology/pin rules (ports, Parallel/Merge, reconvergence, expression policy) are one domain grammar with staged helpers. | `executable-workflow-branching`, `parallel-output-assurance`; no finding |
| `packages/workflow-engine/src/executable-graph-validation-index.ts` | 70 | KEEP | Prepared graph index for compiler validation: nodes, edges, adjacency, ports, and pairings. It already removes repeated publication scans and is the natural PF-06 extension seam. | `executable-workflow-branching`, `scheduler-projection`; no finding |
| `packages/workflow-engine/src/executable-graph.ts` | 51 | KEEP | Verified executable context lookup and recursive flatten helpers. Called by operations/coordinator/checkpoint validation; bounded graph depth makes recursion appropriate. | `executable-workflow-identity`, `executable-workflow-inputs`; no finding |
| `packages/workflow-engine/src/executable-identity.ts` | 71 | KEEP | Selection fingerprint and V2 checksum projection; compiler and parser share it so identity cannot drift by caller. | `executable-workflow-identity`; no finding |
| `packages/workflow-engine/src/executable-validation.ts` | 287 | KEEP | Raw executable JSON admission and pin primitive parsing; exact hostile reflection and bounded canonicalization are the seam's security invariant. | `executable-workflow-identity`, `serialized-boundary-matrices`, `expanded-public-boundary-coverage`; no finding |
| `packages/workflow-engine/src/executable-workflow.ts` | 30 | KEEP | Stable executable facade hiding implementation files and preserving the supported root exports. | `package-contract`, `executable-workflow-identity`; no finding |
| `packages/workflow-engine/src/graph-scheduler-indexes.ts` | 66 | KEEP | Scheduler-specific graph index for predecessors, adjacency, Merge/Parallel pairings; consumed only by scheduler readiness. | `scheduler-projection`, `skipped-parallel-merge`, `nested-parallel-admission`; no finding |
| `packages/workflow-engine/src/graph-scheduler.ts` | 450 | KEEP | Deep readiness module: branch selection, skip/block propagation, Parallel fan-out, scoped identities, and readiness decisions. Keep the state machine together; PF-06 should extend its prepared index, not split policy. | `advance-workflow-branching`, `scheduler-projection`, `skipped-parallel-merge`, `state-machine-model`; no finding |
| `packages/workflow-engine/src/index.ts` | 51 | KEEP | Explicit root public facade for operations, executable/checkpoint primitives, types, and errors; changing it changes package contract. | `package-contract`; no finding |
| `packages/workflow-engine/src/node-attempt-input.ts` | 250 | INVESTIGATE | Attempt-input seam verifies executable context, structured scope, direct-upstream outputs, and collection proof before mapping. Separate graph lookup/index work is a bounded PF-06 comparison; do not weaken exact-upstream rules. | `executable-workflow-inputs`, `serialized-boundary-matrices`; PF-06 (secondary) |
| `packages/workflow-engine/src/operation-values.ts` | 43 | KEEP | Operation-specific record/exact-key/error helpers intentionally differ from checkpoint/executable parsers in accepted error codes. | `expanded-public-boundary-coverage`, `operation-risk-branches`; no finding |
| `packages/workflow-engine/src/operations.ts` | 488 | KEEP | Production adapter/orchestrator: authentic executable, checkpoint/fact parsing, coordinator derivation, transition core, mapping, preview, attempt execution, and registry seam. It is the correct small set of infrastructure-facing entry points; PF-06 only measures prepared-state reuse beneath it. | `executable-workflow-outcomes`, `executable-workflow-inputs`, `executable-workflow-identity`, `operation-risk-branches`; PF-06 context only |
| `packages/workflow-engine/src/ordering.ts` | 2 | KEEP | Locale-independent ordinal comparator used in deterministic maps/plans; tiny shared primitive is justified. | `scope`, broad deterministic suites; no finding |
| `packages/workflow-engine/src/output-reference.ts` | 13 | KEEP | Exact output-locator equality for checkpoint/coordinator replay; tiny domain primitive. | `checkpoint-seam`, `executable-workflow-outcomes`; no finding |
| `packages/workflow-engine/src/persisted-observation-parser.ts` | 361 | KEEP | Observation-record grammar owns exact keys, timestamps, UUIDs, attempt/status, waits, failures, output references, and safe codes before semantic reconstruction. | `serialized-boundary-matrices`, `checkpoint-seam`, `operation-risk-branches`; no finding |
| `packages/workflow-engine/src/persisted-observations.ts` | 358 | KEEP | Fact-window normalization, dedupe, stale matching, sequence/gap validation, due/deadline/failure extraction, and attempt fencing are one durable observation contract. | `serialized-boundary-matrices`, `operation-risk-branches`, `executable-workflow-outcomes`; no finding |
| `packages/workflow-engine/src/retries.ts` | 164 | KEEP | Retry/unknown/idempotency policy is a closed pure decision owner used by coordinator failures and tests. | `retry-policy-mutation`, `retry-wait-cancellation`, `state-machine-model`; no finding |
| `packages/workflow-engine/src/runtime.ts` | 72 | SIMPLIFY | Testing-only durable-wait/cancellation policy helpers are not called by production code. `CancellationDecision` includes `stop_scheduling`, but `decideCancellation` never returns it; remove the dead variant if compatible or document the reason to retain it. Preserve the production transition engine as owner. | `retry-wait-cancellation`, `expanded-public-boundary-coverage`; WF-S01 |
| `packages/workflow-engine/src/scheduling.ts` | 252 | KEEP | Join settlement, branch disposition, loop state/admission/completion, and canonical engine invocation keys are core pure policies. Public testing exports do not justify splitting invariants. | `branch-join-scheduling`, `foreach-scheduling`, `retry-wait-cancellation`; no finding |
| `packages/workflow-engine/src/scope.ts` | 40 | KEEP | Allocation-light branch/iteration equality and prefix predicates used by scheduler, transitions, and coordinator; one owner prevents scope drift. | `scope`, `state-machine-model`; no finding |
| `packages/workflow-engine/src/server-only.ts` | 4 | KEEP | Node-runtime guard paired with package browser mapping; defense-in-depth seam. | `package-contract`; no finding |
| `packages/workflow-engine/src/testing-graph.ts` | 39 | KEEP | Testing-only unknown graph parser converts model draft/semantic validation into typed scheduler state; keeps raw scheduler state out of production. | `scheduler-projection`, `package-contract`; no finding |
| `packages/workflow-engine/src/testing.ts` | 86 | KEEP | Testing facade validates unknown checkpoint/graph then exposes deterministic transition/scheduling seams; production uses `operations.ts`. | `package-contract`, `advance-workflow-transitions`, `state-machine-model`; PF-05 reproduction seam |
| `packages/workflow-engine/src/transition-decisions.ts` | 110 | KEEP | Pure admission-capacity and terminal-run precedence decisions; callers depend on `outcome_unknown` > control precedence. | `advance-workflow-transitions`, `nested-parallel-admission`, `state-machine-model`; no finding |
| `packages/workflow-engine/src/transitions.ts` | 99 | KEEP | Explicit run/node/attempt transition adjacency tables; mutation tests make this high-value policy local and auditable. | `transition-policy-mutation`, `state-machine-model`; no finding |
| `packages/workflow-engine/src/types.ts` | 303 | KEEP | Stable durable vocabulary for statuses, observations, checkpoint, event, admission, and plan interfaces. Splitting by caller would increase interface knowledge. | `package-contract`, all transition/checkpoint suites; no finding |
| `packages/workflow-engine/src/workflow-transition-derived.ts` | 296 | KEEP | Ordered readiness/join/loop derivation state machine. Event/admission ordering is the invariant; PF-06 may supply indexes but must not fragment sequencing. | `advance-workflow-transitions`, `executable-workflow-foreach`, `state-machine-model`; PF-06 secondary lookup context |
| `packages/workflow-engine/src/workflow-transition-observations.ts` | 527 | KEEP | Applies external/coordinator observations by semantic kind, preserving idempotence, output identity, scopes, controls, and event rules. This is cohesive transition grammar. | `advance-workflow-transitions`, `executable-workflow-controls`, `workflow-transition-risk-behavior`; PF-05 control input owner |
| `packages/workflow-engine/src/workflow-transition-plan.ts` | 186 | KEEP | Final plan/checkpoint/event/admission seam performs bounded admissions, terminal status, sequence assignment, and final parse invariant. | `advance-workflow-transitions`, `executable-workflow-outcomes`, `state-machine-model`; no finding |
| `packages/workflow-engine/src/workflow-transition-state.ts` | 302 | INVESTIGATE | Per-transition mutable state plus declaration/output/event helpers. Its scheduler side-effect/disabled lookups flatten/search repeatedly; compare a private prepared map under PF-06 while preserving fail-closed missing-node behavior. | `scheduler-projection`, `advance-workflow-transitions`, `workflow-transition-risk-behavior`; PF-06 |
| `packages/workflow-engine/src/workflow-transition-stops.ts` | 165 | INVESTIGATE | Stop propagation leaves running effects for reconciliation and settles safe waiting/pending work. Current ordinary waiting precedence is a reproduced PF-05 correctness defect. | `executable-workflow-controls`, `retry-wait-cancellation`, `workflow-transition-risk-behavior`; PF-05 |

### `packages/workflow-model/src` (22 files)

| File | Lines | Role | Interface, caller-specific reason, and disposition | Relevant tests / findings |
|---|---:|---|---|---|
| `packages/workflow-model/src/assert-never.ts` | 3 | KEEP | Browser-safe exhaustiveness helper used by notification/domain switches; too small to split. | `failure-notification`, package contract; no finding |
| `packages/workflow-model/src/canonical-json.ts` | 137 | KEEP | Server-only canonical JSON/inspection owner used by identity, mapping, evaluator, and engine. Own descriptors, symbols, cycles, depth, and deterministic ordering are security/integrity invariants. | `canonical-json`, `expressions`, `workflow-graph-contract`; no finding |
| `packages/workflow-model/src/expression-worker-runtime.ts` | 51 | KEEP | Private one-shot worker protocol: copies canonical context, signals ready/started, evaluates JSONata, and returns bounded protocol values. Evaluator is its sole adapter. | `expressions`; no finding |
| `packages/workflow-model/src/expressions.ts` | 23 | KEEP | Stable expressions facade separating policy types and evaluator implementation; API, worker, engine, and tests import this seam. | `package-contract`, `expressions`; no finding |
| `packages/workflow-model/src/expressions/evaluator.ts` | 368 | INVESTIGATE | Public `JsonataEvaluator` owns validation, context admission, queue, worker lifecycle, timeout, cancellation, shutdown, and output limits. `evaluate` invokes policy projection before queue admission; optional host-side accessor hardening is PF-07. | `expressions`, `mapping`, `package-contract`; PF-07 |
| `packages/workflow-model/src/expressions/policy.ts` | 351 | KEEP | Expression policy/AST/context contract correctly canonicalizes data before worker handoff; the accessor probe is a caller-boundary hardening question, not a policy defect. Keep the policy seam and any future no-getter contract explicit; PF-07. | `expressions`, `mapping`; PF-07 (conditional) |
| `packages/workflow-model/src/failure-notification.ts` | 128 | KEEP | Browser-safe strict policy/context/delivery discriminated schemas used by API/contracts and worker delivery; impossible states are intentionally rejected. | `failure-notification`, contracts; no finding |
| `packages/workflow-model/src/graph-contract.ts` | 296 | KEEP | Browser/public graph structural schema and contract limits. `workflowGraphSchema` is consumed by contracts/schema projection; hostile preflight plus normalization is an intentional contract seam. | `workflow-graph-contract`, `package-contract`, contracts; no finding |
| `packages/workflow-model/src/graph-validation.ts` | 349 | KEEP | Semantic graph validator owns IDs, mappings, edges/cycles, structured topology, loop bounds, aggregate expansion, and bounded issue collection. | `graph`, `workflow-graph-contract`; no finding |
| `packages/workflow-model/src/graph.ts` | 68 | KEEP | Server graph facade combining structural types, parser, semantic validator, identity, compatibility, and integration usage while hiding subpath layout. | `graph`, `workflow-graph-contract`, API/database authoring suites; no finding |
| `packages/workflow-model/src/graph/aggregate.ts` | 65 | KEEP | Accessor-free aggregate node/edge/depth check shared by browser contract and server parser; the small duplicated-looking traversal is a deliberate trust seam. | `workflow-graph-contract`, `package-contract`; no finding |
| `packages/workflow-model/src/graph/identity.ts` | 390 | KEEP | Graph compatibility, integration usage, executable/retained checksum, projection, and draft representation identity. These outputs must share parse/ordering rules; keep owner behind graph facade. | `graph`, `retained-workflow-v1`, API/database publication suites; no finding |
| `packages/workflow-model/src/graph/preflight.ts` | 331 | KEEP | Server hostile-input preflight for JSON document/value, reserved mapping keys, structured depth, aggregate limits, and safe parse; it is deliberately separate from structural Zod parsing. | `workflow-graph-contract`, `package-contract`, API authoring suites; no finding |
| `packages/workflow-model/src/graph/validation-contract.ts` | 77 | KEEP | Shared semantic limit/result/error vocabulary for validator and identity/public facades. | `graph`, `workflow-graph-contract`; no finding |
| `packages/workflow-model/src/graph/validation.ts` | 119 | KEEP | Public semantic-validation orchestration and override validation; returns bounded issues and expansion totals. | `graph`, `workflow-graph-contract`; no finding |
| `packages/workflow-model/src/index.ts` | 76 | KEEP | Explicit server root facade for canonical, graph, mapping, expression, and notification-adjacent model types. | `package-contract`; no finding |
| `packages/workflow-model/src/invocation-identity.ts` | 93 | KEEP | Server invocation identity seam validates scoped branch/iteration input and hashes workflow version/node/scope without run ID in the key. | `graph`, `package-contract`; no finding |
| `packages/workflow-model/src/json-path.ts` | 88 | KEEP | Small browser-compatible JSON path dialect/parser/resolver used by mapping and tests; own-property resolution is the contract. | `mapping`, `graph`; no finding |
| `packages/workflow-model/src/lifecycle.ts` | 97 | KEEP | Pure lifecycle command and trigger-health aggregation used by database authoring lifecycle; separates stable lifecycle from PostgreSQL activation health. | `lifecycle`, database trigger/authoring suites; no finding |
| `packages/workflow-model/src/mapping.ts` | 70 | KEEP | ValueSource resolution seam for literals, paths, structured inputs, and injected `ExpressionEvaluator`; callers get typed missing/error/value outcomes. | `mapping`, engine inputs, API node-testing; no finding |
| `packages/workflow-model/src/observation-window.ts` | 9 | KEEP | Shared storage-to-engine fact-window capacity constants; changing it is a versioned protocol decision. | engine persisted-observation suites, database observation adapters; no finding |
| `packages/workflow-model/src/server-only.ts` | 3 | KEEP | Node-runtime guard paired with package exports/browser mappings; prevents server-only model code in browser bundles. | `package-contract`; no finding |

## Retained clusters and negative conclusions

The following dense clusters were read and retained because their interfaces
hide real state-machine or hostile-input invariants: checkpoint shared/V1/V2
parsers, executable boundary/compiler/rules, graph scheduler, persisted
observation reconstruction, transition observation/derivation/plan, model graph
preflight/validation/identity, and evaluator lifecycle. File length alone is
not a finding. Existing coverage residuals in `docs/remaining-work/workflow.md`
are reviewed evidence categories, not authorization to manufacture private
state or to reopen completed fixes.

No runtime cycles were found in the static relative-import scan. The remaining
all-import SCCs (`graph-scheduler`/`graph-scheduler-indexes`, executable
compilation/boundary/workflow/graph, persisted observation parser/normalizer,
and operations/attempt-input) are type/implementation ownership clusters, not
proof of an architectural cycle. PF-06 should deepen one private prepared-index
seam only if measurement justifies it; it should not create a generic graph
framework or public cache.
