# Workflow engine — file-by-file quality review

Reviewed against the frozen inventory and current dirty source on 2026-09-12.
All **87 files** were read: 50 source modules, 30 test files, two fixture/support
files and five package/build/test configurations. Existing tests:
`pnpm --filter @pertexo/workflow-engine test` — **30 files, 346 tests passed**.
Tests import current engine source and workspace dependency artifacts; this is
not a fresh full-repository build or PostgreSQL/Redis integration run.

Current-source probes reproduced the timestamp, outer observation-array,
checkpoint-cycle, duplicate-output, empty-root-scope and hostile-error behaviors
below. An authentic public For Each transition was also passed to the actual
database status validator, which rejected its unsupported running-body stop.
No provider was called, database changed, or implementation edited.

## Individual dispositions

Paths are relative to `packages/workflow-engine/`. J01–J14 refer to the parent
rubric. KEEP does not mean every conceivable behavior has been proved.

| File | Disposition and concrete judgment |
| --- | --- |
| `packages/workflow-engine/src/advance-workflow.ts` | KEEP explicit checkpoint/observation ordering, cursor accounting and staged transition orchestration. Testing observations and persisted production facts deliberately have different admission contracts. |
| `packages/workflow-engine/src/checkpoint.ts` | KEEP version dispatch, bounded admission and construction through the parser. WQ-037/WQ-038 exercise its public decoder; no new checkpoint version is required for these fixes. |
| `packages/workflow-engine/src/checkpoint-executable-validation.ts` | KEEP cross-checking scoped invocation, branch, join and loop identities against authentic executable topology. Multiple checks defend different persistence invariants; do not collapse them into a generic schema. |
| `packages/workflow-engine/src/checkpoint-identity.ts` | FIX WQ-038. The timestamp name promises more than regex plus finite `Date.parse` establishes. Engine-version and canonical UUID grammar remain explicit persistence contracts. |
| `packages/workflow-engine/src/checkpoint-shared.ts` | FIX WQ-037. KEEP descriptor-based JSON admission, byte accounting and reusable field/scope parsing. The exit-marker representation, not the whole cohesive validator, needs replacement. |
| `packages/workflow-engine/src/checkpoint-v1.ts` | KEEP retained V1 parser, canonical ordering, collection consistency and synthetic-loop compatibility. Do not remove legacy state because current authors publish V2. |
| `packages/workflow-engine/src/checkpoint-v1-join.ts` | KEEP join ledger/outcome consistency validation and legacy root-key handling. These conditions encode all/any/count semantics, not gratuitous nesting. |
| `packages/workflow-engine/src/checkpoint-v1-loop.ts` | KEEP budget, cursor and scoped parent checks. WQ-045 may require tests for retained active ordinals during stop reconciliation; do not weaken invariants to admit a premature terminal plan. |
| `packages/workflow-engine/src/checkpoint-v2.ts` | KEEP additive branch-selection decoding and reserved-budget conservation. Root-scope representation is deliberately retained; WQ-043 aligns its consumer without changing serialized keys. |
| `packages/workflow-engine/src/coordinator-failures.ts` | KEEP ordered durable failure/retry decisions, attempt fencing and stable jitter identity. Definite cancellation and dispatched uncertainty are distinct outcomes. |
| `packages/workflow-engine/src/coordinator-observations.ts` | REFACTOR WQ-040 only for the duplicated loop-observation sort-key expression. KEEP exact output/outcome matching, Parallel verification, loop declaration and projected Merge disposition responsibilities. PF-06 owns conditional repeated-scan optimization. |
| `packages/workflow-engine/src/coordinator-output.ts` | KEEP bounded interpretation of inline/artifact locators and matching successful-outcome identities. A locator is not materialized output. |
| `packages/workflow-engine/src/core-definition-identities.ts` | KEEP explicit supported immutable core identities and historical versions. Do not infer compatibility from a key prefix or the newest catalog entry. |
| `packages/workflow-engine/src/errors.ts` | KEEP small typed engine-error vocabulary. WQ-044 uses the existing errors instead of adding a cross-package error framework. |
| `packages/workflow-engine/src/executable-boundary.ts` | KEEP provenance, global-policy, graph and checksum admission stages with authentic identity registration only after verification. WQ-044 covers normalization of a hostile release rejection. |
| `packages/workflow-engine/src/executable-compilation.ts` | KEEP compilation of pinned node/executor/policy behavior and structured bodies. Preserve deterministic canonical sorting and exact checksum inputs. |
| `packages/workflow-engine/src/executable-compatibility.ts` | KEEP rolling overlap versus retained history distinction. One current-to-target overlap and a longer historical chain serve different operational contracts. |
| `packages/workflow-engine/src/executable-foundation.ts` | KEEP authentic executable registration, immutable behavior comparison and policy ownership; TEST/harden error normalization under WQ-044. Do not expose the identity registry. |
| `packages/workflow-engine/src/executable-graph.ts` | KEEP graph traversal and node-context lookup hiding structured ancestry details. Indexing is conditional under existing PF-06, not an assumed performance incident. |
| `packages/workflow-engine/src/executable-graph-boundary.ts` | REFACTOR WQ-040: separate the long mixed pin predicate into ordered private assertions. KEEP graph reconstruction and recursively pinned body validation. |
| `packages/workflow-engine/src/executable-graph-rules.ts` | KEEP explicit port ownership, branch topology, Merge pairing and reconvergence rules. These are domain constraints, not candidates for a universal graph-rule framework. |
| `packages/workflow-engine/src/executable-graph-validation-index.ts` | KEEP per-validation indexes with a clear bounded lifetime and no invalidation requirement. Do not promote to a process cache. |
| `packages/workflow-engine/src/executable-identity.ts` | KEEP distinct selection/provenance and executable behavior identity; golden tests protect exact canonical material. |
| `packages/workflow-engine/src/executable-validation.ts` | KEEP tagged iterative JSON traversal and descriptor-safe normalization. This existing representation is a useful local example for WQ-037, not a reason to merge all package validators. |
| `packages/workflow-engine/src/executable-workflow.ts` | KEEP explicit internal executable facade and associated types. Export grouping makes ownership discoverable without adding runtime layers. |
| `packages/workflow-engine/src/graph-scheduler.ts` | KEEP selected/skipped branch semantics and scoped readiness derivation. PF-06 owns a measured indexing proposal; preserve first-match and scope behavior if it proceeds. |
| `packages/workflow-engine/src/graph-scheduler-indexes.ts` | KEEP local projection indexes; their precise scope keys matter more than shortening the file. |
| `packages/workflow-engine/src/index.ts` | KEEP explicit production exports and server guard. Generic graph/scheduler mutation primitives remain off the production entry. |
| `packages/workflow-engine/src/node-attempt-input.ts` | FIX WQ-042 and WQ-043. KEEP exact upstream descriptors, structured ancestry and collection checksum proof. Duplicate resolution and absent-versus-empty root scope need precise contracts. |
| `packages/workflow-engine/src/operation-values.ts` | KEEP small local JSON-record, exact-key and typed-error helpers. Its optional-key distinction is useful; no class abstraction is needed. |
| `packages/workflow-engine/src/operations.ts` | KEEP deep public advance/attempt/preview operations and mapped-input bounds; harden the external rejection path under WQ-044. PF-06 owns scheduler projection optimization. |
| `packages/workflow-engine/src/ordering.ts` | KEEP ordinal comparator; locale collation must not determine durable ordering. |
| `packages/workflow-engine/src/output-reference.ts` | KEEP explicit reference-kind comparison. Matching only a string ID would discard kind identity. |
| `packages/workflow-engine/src/persisted-observation-parser.ts` | KEEP discriminated fact parsers and attempt/output correlation. WQ-038 preserves the stricter canonical observation timestamp format while fixing comparisons with retained checkpoints. |
| `packages/workflow-engine/src/persisted-observations.ts` | FIX WQ-038/WQ-039. KEEP fact/window byte limits, contiguous cursor admission, duplicate equivalence and stale-attempt checks. Per-fact limits cannot be replaced with a single generic whole-array limit. |
| `packages/workflow-engine/src/retries.ts` | KEEP ordered side-effect/recommendation policy, bounded delay and deterministic provider identity. Existing policy mutations and generated cases are meaningful independent oracles. |
| `packages/workflow-engine/src/runtime.ts` | KEEP durable-wait and cancellation decision helpers at the testing seam. Existing WF-S01 owns the unused `stop_scheduling` variant; do not invent a second removal item. |
| `packages/workflow-engine/src/scheduling.ts` | KEEP invocation identity, deterministic join settlement and bounded loop admission. These cohesive domain algorithms should not be split by line count. |
| `packages/workflow-engine/src/scope.ts` | KEEP exact/prefix scope comparisons without delimiter serialization. WQ-043 aligns the attempt consumer with its established empty-root equivalence. |
| `packages/workflow-engine/src/server-only.ts` | KEEP Node runtime guard in addition to conditional package exports. |
| `packages/workflow-engine/src/testing.ts` | KEEP explicit testing-only scheduler input and ambiguity rejection. It is intentionally less restrictive than the authentic production executable seam. |
| `packages/workflow-engine/src/testing-graph.ts` | KEEP graph-to-test-scheduler projection; WQ-044 tests secondary errors from unknown input without claiming this is the production graph admission route. |
| `packages/workflow-engine/src/transition-decisions.ts` | KEEP terminal precedence and bounded scoped attempt admission; the existing run-level cancellation precedence is not the PF-05 bug. |
| `packages/workflow-engine/src/transitions.ts` | KEEP explicit transition tables and named assertions. Independent test tables should not be generated from these production tables. |
| `packages/workflow-engine/src/types.ts` | KEEP domain observation, checkpoint and transition-plan vocabulary together. WF-S01 concerns a runtime helper variant, not permission to redesign all unions. |
| `packages/workflow-engine/src/workflow-transition-derived.ts` | KEEP ordered root/body readiness, join settlement and loop admission phases. WQ-045 must preserve reconciliation without admitting another ordinal. PF-06 owns repeated projection work. |
| `packages/workflow-engine/src/workflow-transition-observations.ts` | KEEP family-specific observation application and durable-fact event suppression. WQ-045 may need a focused loop-terminal reconciliation adjustment; do not rewrite the complete state machine. |
| `packages/workflow-engine/src/workflow-transition-plan.ts` | KEEP final admission/event/checkpoint construction and nonterminal guard on run finalization. WQ-045 corrects upstream state, not this guard. |
| `packages/workflow-engine/src/workflow-transition-state.ts` | KEEP mutable transition state private to one advancement and explicit declaration equivalence. Do not export this implementation state to callers. |
| `packages/workflow-engine/src/workflow-transition-stops.ts` | FIX existing PF-05 for simultaneous ordinary Wait controls; FIX WQ-045 for running loop-body reconciliation. They share a file but have distinct triggering states and acceptance tests. |
| `packages/workflow-engine/test/advance-workflow-branching.test.ts` | KEEP exact selected/skipped scope and admission-cap assertions through the testing scheduler interface. Do not describe hand-authored scheduler state as production executable verification. |
| `packages/workflow-engine/test/advance-workflow-risk-branches.test.ts` | KEEP compact admission/cursor invalidity matrix and the accepted empty window control. |
| `packages/workflow-engine/test/advance-workflow-transitions.test.ts` | KEEP coherent named transition/replay tests with explicit scheduler setup. Existing PF-05 adds combined-control precedence. |
| `packages/workflow-engine/test/branch-join-scheduling.test.ts` | KEEP independent all/any/count expectations, explicit missing/skipped branches and duplicate conflict behavior. |
| `packages/workflow-engine/test/checkpoint-risk-branches.test.ts` | TEST/readability WQ-041: the negative-zero test asserts preservation, not canonicalization. KEEP subject-specific diagnostics and accepted/rejected ledger/loop matrices. |
| `packages/workflow-engine/test/checkpoint-seam.test.ts` | TEST WQ-037/WQ-038; KEEP zero-accessor/zero-proxy-trap checks, legacy recovery and one-over bounds. Its broad elapsed-time bound is a smoke alarm, not a scaling benchmark. |
| `packages/workflow-engine/test/coverage-config.test.ts` | KEEP exact configured inventory/ratchet assertion; inspect actual source coverage separately before making completeness claims. |
| `packages/workflow-engine/test/executable-workflow-branching.test.ts` | KEEP public Condition/Switch/Parallel/Merge scenarios; WQ-043 adds admission-to-attempt forwarding with empty root iteration scope. The current Merge execution case omits that field. |
| `packages/workflow-engine/test/executable-workflow-controls.test.ts` | TEST WQ-038/WQ-039 and existing PF-05. KEEP current attempt fencing, due ordering, active-work reconciliation and released-slot cases. |
| `packages/workflow-engine/test/executable-workflow-foreach-part-2.test.ts` | KEEP nested execution, exact scope/checksum proof and reserved IDs. WQ-041 separates unrelated attempt-input scenarios within the broad input test without losing the nested end-to-end case. |
| `packages/workflow-engine/test/executable-workflow-foreach.test.ts` | FIX test expectations under WQ-045; REFACTOR WQ-041. One 923-line file currently contains one scenario-bundled test, including premature active-body cancellation assertions. |
| `packages/workflow-engine/test/executable-workflow-identity.test.ts` | KEEP golden identity, historical lifecycle and selected-policy drift tests; WQ-040/WQ-044 add targeted preservation/hostile-error cases. Name the anonymous malformed-input matrix rows under WQ-041. |
| `packages/workflow-engine/test/executable-workflow-inputs.test.ts` | TEST WQ-042/WQ-043/WQ-044; REFACTOR WQ-041. KEEP confirmed-success-after-abort and exact typed executor failure identity. |
| `packages/workflow-engine/test/executable-workflow-outcomes.test.ts` | KEEP factual cursor/attempt/retry/uncertainty assertions. WQ-041 strengthens provider-key comparison so two absent values cannot satisfy it. |
| `packages/workflow-engine/test/executable-workflow.fixtures.ts` | REFACTOR WQ-041: fixture-specific definition table and direct test imports replace nested manifest ternaries and a production-symbol re-export hub. Preserve independent pinned fixture behavior. |
| `packages/workflow-engine/test/expanded-public-boundary-coverage.test.ts` | KEEP representative public behavior checks; WQ-044 extends the current string-throw fixture to hostile secondary inspection. WQ-041 labels anonymous mutation cases. |
| `packages/workflow-engine/test/foreach-scheduling.test.ts` | TEST WQ-041: self-equality of the same invocation-key function call is weaker than an independent exact identity expectation. KEEP bounded batch and budget cases. |
| `packages/workflow-engine/test/nested-parallel-admission.test.ts` | KEEP substantial multi-level scope/cap/retry/recovery driver. A stateful test driver earns its abstraction by exercising real public transitions; no production scheduler logic belongs in it. |
| `packages/workflow-engine/test/operation-risk-branches.test.ts` | TEST WQ-039/WQ-042/WQ-043/WQ-044. KEEP exact 10,000/10,001 fact-window tests and named diagnostics; those limits must survive outer-array hardening. |
| `packages/workflow-engine/test/package-contract.test.ts` | KEEP server-only export and first-statement checks as narrow packaging evidence, not complete transitive bundle proof. |
| `packages/workflow-engine/test/parallel-output-assurance.test.ts` | KEEP exact material/attempt/sequence/port checks, duplicate acceptance and recovery without historical material. |
| `packages/workflow-engine/test/q9-bounded-work.test.ts` | KEEP diagnostic population search and honest non-attributable memory label. Add an explicit expected upper-cap assertion only if required by the Q9 contract; do not infer latency scaling from this smoke probe. |
| `packages/workflow-engine/test/retry-policy-mutation.test.ts` | KEEP independent policy decision table and incomplete provider identity cases. A table of expected kinds is appropriate here because narrow tests separately pin delay/reason details. |
| `packages/workflow-engine/test/retry-wait-cancellation.test.ts` | KEEP provider-key golden value, bounded jitter, unsafe uncertainty and reconciliation tests. Existing WF-S01 owns any exhaustive-consumer edit. |
| `packages/workflow-engine/test/scheduler-projection.test.ts` | KEEP instrumented exactly-once structured-body traversal test; this is intentionally a trusted projection fixture, not valid public JSON admission. |
| `packages/workflow-engine/test/scope.test.ts` | KEEP Unicode/delimiter scope tests and explicit absent/empty iteration equivalence; useful preservation oracle for WQ-043. |
| `packages/workflow-engine/test/serialized-boundary-matrices.test.ts` | KEEP authentic compiled input, serialized state mutation, precise diagnostics and positive retained-join control. WQ-038/WQ-043 add retained representation cases. |
| `packages/workflow-engine/test/skipped-parallel-merge.test.ts` | KEEP skipped-region recovery through public execution. WQ-043 removes the need for its local empty-iteration filtering and tests direct forwarding. |
| `packages/workflow-engine/test/state-machine-model.test.ts` | KEEP deterministic seeds, bounded generated DAGs and independent conservation/monotonicity invariants. WQ-045 corrects the generated multi-active-iteration cancellation expectation. |
| `packages/workflow-engine/test/transition-policy-mutation.test.ts` | KEEP independent exhaustive transition tables; duplication of the expected policy is intentional test independence. |
| `packages/workflow-engine/test/workflow-transition-risk-behavior.test.ts` | TEST WQ-041: add the positive idempotent join case named by the test; replace the all-family test that stops at its first `join_invalid` with targeted observable ordering cases. |
| `packages/workflow-engine/test/support/advance-workflow.fixture.ts` | KEEP explicit testing-state reconstruction, with safe classes intentionally limited to this fixture. Do not reuse it as production side-effect qualification. |
| `packages/workflow-engine/package.json` | KEEP direct workspace dependencies, pinned fast-check and server-only production/testing entries. |
| `packages/workflow-engine/tsconfig.json` | KEEP existing composite ES2024/NodeNext declarations and workspace project references. |
| `packages/workflow-engine/tsconfig.test.json` | KEEP no-emit source/test/config checking and existing build architecture. |
| `packages/workflow-engine/vitest.config.ts` | KEEP minimal package-local Node unit configuration. |
| `packages/workflow-engine/vitest.coverage.config.ts` | KEEP expanded runtime inventory and stronger original-cohort ratchet. Coverage percentages do not substitute for the missing behavioral oracles below. |

## WQ-037 — P2: distinguish traversal exit frames from cyclic input

Files: `src/checkpoint-shared.ts:128–190`, `test/checkpoint-seam.test.ts`.
Criteria J02/J03/J06/J11/J12.

The traversal pushes `{ value: item, depth }` as an exit sentinel and also puts
`item` in `exits`. Before checking `ancestors`, it treats any next occurrence
of the same object as that exit. A cyclic child is therefore mistaken for the
sentinel; the real sentinel later re-enters the object. A one-object self-cycle
reproduces `checkpoint_invalid / checkpoint exceeds maximum members`, rather
than the cycle diagnostic. The quotas still bound and reject the input: this
is **not an unbounded-loop claim**.

Replace the ambiguous object-identity sentinel with a private tagged frame:

```ts
type Frame =
  | { kind: 'value'; value: unknown; depth: number }
  | { kind: 'exit'; value: object };
// An exit frame removes an ancestor. A value frame never impersonates an exit.
```

Keep one ancestor set; remove the separate `exits` set. Preserve descriptor,
byte/depth/member checks and shared-but-acyclic JSON counting. Do not merge the
checkpoint and executable validators just to share this small representation.

Acceptance: self-cycle, two-object cycle and cyclic array fail at the cycle
guard; repeated acyclic references remain accepted where schema-valid and are
counted per serialized occurrence. Existing exact/one-over, proxy and hidden
field tests pass with zero user getters invoked. No schema/checksum change.

## WQ-038 — P2: validate real timestamps and compare instants

Files: `src/checkpoint-identity.ts:6–35`,
`src/persisted-observations.ts:265–279`,
`src/persisted-observation-parser.ts:26–35`; tests in `checkpoint-seam`,
`executable-workflow-controls`, and `serialized-boundary-matrices`.
Criteria J01/J04/J06/J12.

Two current behaviors belong to the same timestamp contract repair:

1. Checkpoint parsing accepts `2026-02-30T00:00:00Z` and
   `2026-09-12T24:00:00Z`; finite `Date.parse` permits calendar rollover.
2. A valid retained checkpoint with `resumeAt: "2026-09-12T10:00:00Z"` rejects
   a due observation at `2026-09-12T10:00:00.000Z` as `due observation is early`.
   The public `advanceWorkflow` probe reproduces this with authentic executable
   identity and a previously admitted invocation. Lexical comparison of those
   different accepted spellings is not chronological comparison.

Keep valid retained whole-second and millisecond checkpoint strings accepted.
Validate their calendar round trip against an equivalent millisecond form;
do not silently rewrite stored checkpoint strings or broaden observation
admission. Compare the two validated instants numerically for due eligibility:

```ts
Date.parse(due.occurredAt) < Date.parse(invocation.resumeAt)
```

Acceptance: equal instants in both allowed checkpoint spellings resume once;
one millisecond early still rejects; later resumes; valid leap day succeeds;
invalid day/month/hour rollovers fail; observation timestamps retain their
existing stricter canonical form. Check retained checkpoint fixtures and the
database decoder before tightening validation. Do not change UUID/version
grammar or introduce a general date library.

## WQ-039 — P2: admit the outer observation array without executing it

Files: `src/persisted-observations.ts:103–136`,
`test/operation-risk-branches.test.ts`, `test/executable-workflow-controls.test.ts`.
Criteria J06/J08/J09/J11/J12.

`Array.isArray(value)`, an unguarded `value.length`, and `value.map(...)` inspect
the caller's outer collection before descriptor-safe per-fact normalization.
A public-operation probe invokes an index getter once and accepts its returned
cancellation fact. An array proxy throwing from `length` escapes as a raw Error
with no `observation_invalid` code. A custom `map`/species path is unnecessary
caller-controlled behavior at this unknown-input seam.

Admit a bounded dense ordinary array using proxy rejection and own data
descriptors before processing facts. Iterate the admitted entries without
calling caller-owned methods or accessors. Normalize failures without probing
an arbitrary thrown object's prototype/message. Keep the existing independent
fact count, per-fact canonical bytes and aggregate window bytes. In particular,
**do not normalize the complete window with the smaller generic engine JSON
member budget**: the accepted 10,000-fact test is a required contract.

Acceptance: outer index getters, proxy traps, sparse arrays, custom `map`,
hidden/symbol members and hostile prototype/species cases reject consistently
without executing caller code. Valid 10,000-fact window still advances;
10,001 facts and both byte ceilings still reject. Duplicate/cursor ordering
semantics are unchanged. No claim of a network JSON exploit is made: these
objects are reachable through the in-process public unknown-input interface.

## WQ-040 — P2: expose the concepts inside two dense expressions

Files: `src/executable-graph-boundary.ts:135–204` (`validatePin`),
`src/coordinator-observations.ts` (`forEachCoordinatorObservations` final sort);
preservation tests in executable identity, expanded public boundary, nested
Parallel and For Each tests. Criteria J02/J03/J04/J05.

The pin condition combines admission lifecycle, immutable behavior equality,
definition/config/executor/ABI matching, side-effect matching, policy matching,
definition membership and current lifecycle eligibility. Each is necessary;
the problem is the interleaved reading burden, not the number of rules.

Use private ordered assertions for those phases, retaining the current generic
failure code/message and short-circuit order. Avoid eagerly computing all
predicates, a public `PinValidationContext`, or a new validation framework.
An illustrative call sequence, not a required exported interface:

```ts
assertAdmissionLifecycle(...);
assertRetainedBehavior(...);
assertNodePinIdentity(...);
assertPinnedPolicies(...);
assertCurrentExecutionEligibility(...);
```

Keep parsing and result construction local. Preserve active/deprecated
admission, retained execution, retirement-blocked already-admitted execution,
ABI and side-effect truth, selected-policy identity and golden checksums.

The loop-observation sorter separately duplicates a nested ternary/template
expression for left and right keys. A private exhaustive `loopObservationKey`
helper should state control-key fallback, declaration-before-completion order
and padded ordinal ordering once. Preserve exact key strings and compare
behavior; no new serialized ordering format. These are two small independent
refactors and need not share a commit or introduce another source module.

## WQ-041 — P2: make engine tests explain what they actually prove

Criteria J02/J04/J05/J12. Exact targets:

- `test/executable-workflow-foreach.test.ts:13–922`: split the single test into
  declaration/replay, sequential completion, retry/failure, budget/empty/artifact
  cases, checkpoint tampering, skipped body, cancellation/deadline and concurrent
  completion cases. Use a small public-operation setup returning named stages
  (`afterManual`, `declared`, `afterRoot`) or a focused driver. Each case owns
  fresh state. No before-all mutation chain or hidden assertion loop.
- `test/executable-workflow-inputs.test.ts`, test `resolves mapped inputs and
  preserves confirmed success after abort`: separate mapping semantics, invalid
  identities/upstream data, success-after-abort and the executor-error matrix.
  Keep real evaluator shutdown and explicit exact `NodeExecutorFailure` identity.
- `test/executable-workflow-foreach-part-2.test.ts`, test `executes structured
  input and exact scoped upstream output`: separate same-iteration output,
  nearest item, tampered checksum and nested nearest-input cases. Keep the
  independently named full nested completion scenario intact.
- `test/executable-workflow.fixtures.ts:64–178`: replace nested family/port
  ternaries with a local table keyed by the supported fixture definitions;
  retain explicit expected version-dependent fields. Do not import production
  manifests to generate expected compatibility behavior. Move production-symbol
  imports in test consumers to the actual production/testing entries, leaving
  this file responsible for fixture construction, not a package re-export hub.
- `test/workflow-transition-risk-behavior.test.ts`: the named idempotent join
  case only asserts conflicting rejection. Add a separate identical replay
  assertion with no additional events/admissions. Its all-observation-family
  ordering case throws at an undeclared join and cannot prove later families
  were applied; replace that broad claim with focused ordering observations.
- `test/checkpoint-risk-branches.test.ts`: rename `canonicalizes a negative-zero
  numeric field` to preservation unless a separate compatibility decision
  intentionally changes the current `Object.is(..., -0) === true` assertion.
- `test/foreach-scheduling.test.ts`: replace `invocationKey(input) ===
  invocationKey(input)` with an independently specified complete expected key,
  plus changed-version/node/path distinctions. Keep generated scope tests too.
- `test/executable-workflow-outcomes.test.ts`, provider key before capacity:
  assert exactly one relevant materialization and attempt, nonempty keys, and
  the expected identity before comparing them. Two optional missing values
  must not pass an intended stable-key assertion.
- `test/executable-workflow-identity.test.ts` and
  `test/expanded-public-boundary-coverage.test.ts`: give anonymous hostile-value
  and mutation rows descriptive labels. Preserve each negative case and golden
  checksum; do not split coherent matrices into one file per case.

Acceptance: all existing behavioral assertions remain represented, each failure
identifies the relevant behavior, each scenario can run independently, and the
full suite/coverage ratchets pass. WQ-045 intentionally changes the incorrect
running-body stop expectation; do that as a behavioral fix, separately from
the mechanical test reorganization. Test count growth is not the success metric.

## WQ-042 — P2: reject conflicting exact-upstream output descriptors

Files: `src/node-attempt-input.ts:125–147`,
`test/executable-workflow-inputs.test.ts`, `test/operation-risk-branches.test.ts`.
Caller check: `packages/database/src/execution/node-attempt-run-store-inputs.ts`
(`reconcileCompletedNodeOutputs`). Criteria J01/J06/J10/J12.

After validating exact upstream identity, the array parser unconditionally
assigns `outputs[nodeId] = value`. A public `executeNodeAttempt` probe with the
same exact descriptor identity twice and values 1 then 2 passes `{ result: 2 }`
to the registry; reversing rows passes `{ result: 1 }`. The engine silently
accepts contradictory evidence and depends on loader order.

The current database loader selects uniquely identified succeeded node rows and
checks expected row count, so this probe does **not** establish ordinary SQL
loads can produce the conflict. The defect is the public descriptor-admission
contract, not a demonstrated stored-output corruption incident.

Use the already validated node/invocation identity to detect repeated entries.
Accept identical canonical JSON duplicates idempotently and reject differing
values with `attempt_invalid` before registry execution. Preserve null-prototype
storage, reserved node-ID handling, direct-upstream checks and scoped identity.
Do not replace values by “first wins”; that merely reverses the ambiguity.

Acceptance: identical duplicates yield the same mapping; conflicting duplicates
reject in either order with zero registry calls; different upstream nodes remain
independent; nested/branch-scoped descriptors and legacy root-object input keep
their current valid behavior. No persistence migration or loader rewrite unless
a real caller regression demonstrates it is necessary.

## WQ-043 — P2: treat an empty iteration path as root scope consistently

Files: `src/node-attempt-input.ts:163–173`,
`test/executable-workflow-inputs.test.ts`, `test/executable-workflow-branching.test.ts`,
`test/skipped-parallel-merge.test.ts`. Criteria J01/J03/J05/J12.

`parseStructuredInputs` returns early only for `iterationPath === undefined`.
The public attempt probe with `iterationPath: []` instead throws
`structured collection proof is missing`, although ancestry validation and
invocation-key construction both treat it as root. V2 parsing also emits empty
iteration paths for branch-scoped invocations. The skipped-Parallel test
explicitly strips that empty array before calling the attempt operation.

The database claim path currently strips empty branch/iteration arrays too
(`node-attempt-run-store-claim.ts:241–250`), so this is **not** a claim that every
production branch currently fails. It is an unnecessary representation rule
leaking into callers of the engine interface.

Return no structured inputs when `(input.iterationPath?.length ?? 0) === 0`.
For nonempty paths retain every ancestry, ordinal and collection-checksum check.
Do not rewrite checkpoint serialization, invocation keys or stored branch
contexts. Existing database normalization may remain for compatibility.

Acceptance: identical root and branch-only attempts accept omitted and empty
iteration paths with equal outputs; forwarding a parsed V2 invocation's scope
works without caller cleanup. Missing proof still rejects a real loop-body
attempt. Foreign ancestry, malformed ordinal and wrong checksum still fail.

## WQ-044 — P2: prevent secondary exceptions while classifying unknown errors

Files: `src/operations.ts:316–322,473–479`,
`src/executable-foundation.ts` (`normalizeError`), `src/testing-graph.ts` catch;
tests in executable inputs, identity and expanded public boundary.
Criteria J06/J08/J12.

The registry and expression-evaluator seams can reject arbitrary JavaScript
values. `isAbortError` uses `instanceof` and reads `name` without protecting
inspection. A public attempt probe with a rejection proxy whose prototype trap
throws escaped the secondary raw `Error("secondary-throw")`, replacing the
intended stable engine error. Existing tests cover Error, DOMException, typed
executor failure and a primitive throw, not hostile classification itself.

Protect classification with a narrow fail-closed inspector; reject proxies
without invoking traps where possible and guard descriptor/property inspection.
Preserve trusted `NodeExecutorFailure` object identity, existing aborted-signal
precedence, confirmed success after abort, and generic safe error messages.
Apply the same regression pattern to `normalizeError` and testing graph parsing
only at their actual unknown-error seam; do not blanket-wrap every internal
catch or export a new shared framework. WQ-039 owns outer-array admission;
PF-07/WQ-030 own related behavior in other packages.

Acceptance: proxy/revoked-proxy rejections and throwing `name`/`message` getters
do not cause secondary escape; safe engine code/message is stable; ordinary
aborts and typed executor failure identity retain current semantics. Test the
registry and expression evaluator separately, with zero raw error-message
disclosure and no provider involved.

## WQ-045 — P1: reconcile running For Each body attempts before stopping the loop

Primary files: `src/workflow-transition-stops.ts:34–111`,
`src/coordinator-observations.ts` loop completion derivation,
`test/executable-workflow-foreach.test.ts:638–728`,
`test/state-machine-model.test.ts` generated structured cancellation case.
Integration seam: database `coordinator-run-store-status-validation.ts`
(`acceptRunningCompletion`, `validateInvocationTransition`) and
`coordinator-run-store-execution.ts` (`persistRunEvents`). Criteria
J01/J03/J09/J10/J12. Follow ADR 007 truthful cancellation and ADR 020 body stops.

For an active structured loop, the stop pass changes **every nonterminal body
invocation, including running work**, to canceled/timed_out, completes all
active ordinals and terminalizes the control. In contrast, ordinary running
invocations wait for durable completion/reconciliation. The For Each tests
currently encode the premature terminal result.

A current-source probe used an authentic For Each executable with an unsafe
body, admitted `body-first` as running, then supplied only a persisted cancel
fact. The engine returned run `canceled`, no active ordinals and body/control
terminal events. Passing this exact plan and cancellation fact to the actual
database status validator produced `CoordinatorPlanInvalidError`. Its running
completion path requires an outcome/failure fact, and its event persistence
only directly terminalizes pending/ready/waiting physical rows.

Therefore the demonstrated consequence is a **non-committable coordinator
plan while body attempts remain active**, not a proven false canceled database
commit or lost external effect. No live PostgreSQL/worker retry run was performed.

Plan:

1. Retain running body invocations and active ordinal identity until their
   persisted outcomes/reconciliation facts arrive. Stop pending/ready/released
   waiting work with the already-decided control precedence. Never admit later
   ordinals while a cancel/deadline flag is set.
2. Complete an ordinal only when its required admitted work has terminal facts;
   handle branching and nested loop controls without mistaking a waiting
   coordinator barrier for an ordinary released Wait. Preserve completed
   outputs and any `outcome_unknown` precedence. Do not fabricate a provider
   cancellation result from the run flag.
3. Retain enough loop/control state for the next advancement to consume late
   success, canceled, timed-out or unknown outcomes idempotently. Keep budget
   reservation and cursor accounting unchanged across crash/replay.
4. Keep database validation fail-closed; do not broaden it to accept invented
   running completions. Add the real coordinator transaction regression with a
   running body attempt, then cancellation/deadline, then fenced completion.

Acceptance matrix: safe/idempotent/unsafe body classes; cancel only, deadline
only and both; one/two active ordinals; nested body and branch-scoped body;
running alongside waiting/ready work; known success and unknown result arriving
after stop; duplicate stop and fresh-worker checkpoint recovery. Every interim
plan commits through the real coordinator store, no new attempt is admitted,
running attempt truth is preserved, and final run status follows ADR 007.

Coordinate this focused fix with PF-05 because both edit the stop pass. The
older PF-05 instruction to “keep loop semantics” must mean preserving legitimate
loop scope/budget/terminal truth, **not** preserving the newly evidenced invalid
running-body terminalization. No new architecture/ADR is proposed.

## Implementation order and verification

1. WQ-045 with the existing PF-05 stop-precedence work: distinct regressions,
   shared integration review, no broad scheduler rewrite.
2. WQ-038 and WQ-039 as independent decoder fixes with their public regressions.
3. WQ-037, WQ-042, WQ-043 and WQ-044 as focused behavior/hardening units.
4. WQ-040 readability changes after behavior is pinned; WQ-041 test cleanup in
   small coherent areas, retaining corrected behavior and independent oracles.
5. Existing PF-06 only after its benchmark gate; WF-S01 under its existing plan.

For each unit run its named tests, then engine typecheck/build and the complete
engine suite. Run affected worker/database tests for input/stop contracts, and
real PostgreSQL/Redis coordinator integration for WQ-045/PF-05. Re-run coverage
ratchets after test reorganization. No external runtime qualification is implied
by the 346 passing existing unit tests or the local validator probe.
