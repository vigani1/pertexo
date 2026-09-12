# Workflow model — file-by-file judgment

Primary review: all 39 files read, including fixtures and complete test bodies.
Package pretest compiled workflow-model; **9 test files / 97 tests passed**.
Focused current-source probes below separately exposed untested cases.
ADRs 002, 008, 009, 020 and 032 constrain these judgments; retained identity,
expression policy and structured execution must not be casually redesigned.

| File | Judgment | Reason / required work |
| --- | --- | --- |
| `packages/workflow-model/src/canonical-json.ts` | KEEP — J01, J06 | Sorts keys, uses own descriptors, rejects non-JSON and limits recursive depth. Its ancestor-based repeated-reference policy differs from SDK admission; do not consolidate the two algorithms without preserving versioned semantics. Generic canonicalization is not itself a bounded-payload admission interface. |
| `packages/workflow-model/src/assert-never.ts` | KEEP — J03 | Small exhaustive-union failure helper; unreachable typed variants are not an untrusted error formatter. |
| `packages/workflow-model/src/invocation-identity.ts` | KEEP — J01 | Run namespace is returned separately; hash deliberately uses version/node/scope, not run ID or attempt. URI escaping separates branch and loop scope segments. Do not “fix” identical invocation hashes across runs. |
| `packages/workflow-model/src/observation-window.ts` | KEEP — J01, J11 | Fixed protocol limits and versioning warning are meaningful durable contracts. |
| `packages/workflow-model/src/failure-notification.ts` | KEEP — J03, J09 | Strict destination/result variants separate definite failure from possible dispatch. Fixed context fields exclude arbitrary payloads; producer owns the final context-byte envelope. Lowercasing email domain only is deliberate. |
| `packages/workflow-model/src/lifecycle.ts` | KEEP — J01–J03 | Early exits encode precedence, including failure before archived convergence and zero triggers being active for a published active workflow. Do not conflate lifecycle with activation or run cancellation. The short nested activation ternary has only three meaningful outcomes. |
| `packages/workflow-model/src/json-path.ts` | CONDITIONAL/TEST — WQ-013 | Small dialect is clear and shared with Validate. Object lookup checks own ownership; array lookup does not. Pin the public array behavior and fix the narrow discrepancy without introducing a new dialect. |
| `packages/workflow-model/src/mapping.ts` | KEEP — J02, J05 | Ordered value-source cases preserve missing versus null and propagate expression errors/cancellation. Two-level result ternary is locally understandable; a new resolver class would add little. |
| `packages/workflow-model/src/expressions/policy.ts` | Existing PF-07; otherwise KEEP | AST policy is allowlist-based, not substring filtering. Context projection accessor/hostile exception behavior remains the explicitly scoped PF-07 decision. Keep policy/library constants and reject unknown policy versions; no new built-ins in a cleanup. |
| `packages/workflow-model/src/expressions/evaluator.ts` | FIX/TEST — WQ-010 | Queue/active/startup/deadline phases are real lifecycle complexity. Worker ownership is dropped before termination settles, allowing shutdown to return early. The permissive response flags also merit protocol tests while this owner is edited, not a speculative sandbox claim. |
| `packages/workflow-model/src/expression-worker-runtime.ts` | KEEP — J07, J09 | One-shot worker receives a supervisor-created structured clone; reconstitutes null-prototype data and copies output. It is not a general hostile-code OS sandbox. Keep isolate-local JSONata and no application services. |
| `packages/workflow-model/src/expressions.ts` | KEEP — J05, J13 | Explicit facade hides language policy versus lifecycle implementation ownership. |
| `packages/workflow-model/src/graph-contract.ts` | FIX/REFACTOR — WQ-011, WQ-012 | Browser structural schema intentionally differs from publish semantics, but JSON depth and hostile-input handling drift from server draft admission. Separate enter/exit frames make traversal ownership explicit. |
| `packages/workflow-model/src/graph/aggregate.ts` | KEEP — J05, J11 | Shared iterative aggregate node/edge/structured-depth counting avoids per-body-only limits. It assumes preceding JSON inspection; do not call it standalone as a full graph validator. |
| `packages/workflow-model/src/graph/preflight.ts` | FIX — WQ-012; coordinate WQ-011 | Own-descriptor checks and explicit frames are useful. `safeParse` catch re-inspects arbitrary thrown values; later structural parse also rereads the original object. Keep detailed code/path diagnostics for normal server failures. |
| `packages/workflow-model/src/graph/validation-contract.ts` | KEEP — J06 | Distinct draft-contract versus semantic issue types and bounded result union are appropriate. Move shared admission constants only as needed for WQ-011, avoiding runtime import cycles. |
| `packages/workflow-model/src/graph/validation.ts` | KEEP — J01, J05 | Public typed semantic validation supports controlled limit overrides and capped issues. Rebuilding the override schema on each call is a minor allocation, not a demonstrated performance defect. The function assumes a parsed graph; do not silently redefine it as arbitrary-object admission. |
| `packages/workflow-model/src/graph-validation.ts` | KEEP — J01–J05 | Helpers have meaningful jobs: local indexing, mapping visibility, edges, DAG checks, loop limits and body topology. Many conditions encode distinct invariants. Shared traversal maps and explicit loop totals are clearer than generic validators. |
| `packages/workflow-model/src/graph/identity.ts` | KEEP — J01, J05 | Shared node iteration retains callers' distinct ordering/dedup policies. Draft representation, retained checksum, executable projection and integration usage have different contracts; avoid hashing one generic object for all. |
| `packages/workflow-model/src/graph.ts` | KEEP — J13 | Stable server facade and canonical empty graph; implementation helpers remain private. |
| `packages/workflow-model/src/index.ts` | KEEP — J13 | Explicit stable server surface, independently pinned by package tests. |
| `packages/workflow-model/src/server-only.ts` | KEEP — J13 | Early Node-only guard. |
| `packages/workflow-model/test/canonical-json.test.ts` | KEEP — J12 | Independent byte/key-order assertions, inherited/non-index array rejection and excessive depth; do not equate broad `toThrow` with exact error-contract proof. |
| `packages/workflow-model/test/expressions.test.ts` | TEST — WQ-010; existing PF-07 | Real compiled worker, allowlist execution, exact limits, cancellation and 100-run determinism are substantive evidence. Missing terminating-worker shutdown overlap and termination rejection. The 250ms assertion is an intentional ADR supervisor budget, not an arbitrary sleep to remove. |
| `packages/workflow-model/test/failure-notification.test.ts` | KEEP — J09, J12 | Independent predecessor schema deliberately rejects candidate-only shape, proving rolling compatibility constraints rather than pretending old reader support. Strict extra-field and contradictory-result tests are valuable. |
| `packages/workflow-model/test/graph.test.ts` | TEST/readability with WQ-013 | Rich topology/loop tests. The cross-body mapping test uses two identical `arrayContaining` matchers, which do not prove two distinct issues; require exact offending paths/counts when touching this cohort. Invocation test title should distinguish run namespace from hashed fields. |
| `packages/workflow-model/test/lifecycle.test.ts` | KEEP — J12 | Tests all activation states for idempotent commands and explicit zero-trigger/failure cases. Independently expected matrix avoids deriving answers from implementation. |
| `packages/workflow-model/test/mapping.test.ts` | TEST — WQ-013 | Object inheritance is explicitly rejected; add analogous array test plus dense-index/missing/null regressions. Signal propagation fake satisfies evaluator interface. |
| `packages/workflow-model/test/package-contract.test.ts` | TEST — WQ-011, WQ-012 | Already preserves different diagnostics and aggregate parity. Add config/literal depth parity and hostile structural-read cases; descriptor-count-sensitive fixtures should not become implementation invariants. |
| `packages/workflow-model/test/retained-workflow-v1.test.ts` | KEEP — J01, J12 | Readable-but-non-executable V1 identity, corruption and owned-copy tests; no rewrite of retained data. |
| `packages/workflow-model/test/workflow-graph-contract.test.ts` | TEST — WQ-011, WQ-012 | Golden executable/ETag identities and exact bounds are substantive. Add cross-entrypoint cases without collapsing draft structure into publication semantics. Child-process identity test should receive an explicit timeout when next edited. |
| `packages/workflow-model/test/fixtures/failure-notification-context-candidate-v1.json` | DATA/KEEP — J12 | Run-level timeout without invented node identity; verified by candidate reader and rejected by predecessor reader. |
| `packages/workflow-model/test/fixtures/failure-notification-context-predecessor-v1.json` | DATA/KEEP — J12 | Node-level failure readable by both schemas; stable fake identifiers and fixed error code, no real credential. |
| `packages/workflow-model/test/fixtures/retained-workflow-v1.json` | DATA/KEEP — J01, J12 | Empty graph with pinned original checksum and null executable/compatibility fields; preserve historical bytes/meaning. |
| `packages/workflow-model/package.json` | KEEP — J13 | Browser-safe subpaths explicit; root/canonical/graph/mapping/expressions remain server-only. Pretest builds real worker artifact. |
| `packages/workflow-model/tsconfig.json` | KEEP — J13 | Existing compiled NodeNext build produces worker artifact and declarations; no type-stripping migration. |
| `packages/workflow-model/tsconfig.test.json` | KEEP — J12, J13 | Includes package source/tests/config without emission. |
| `packages/workflow-model/vitest.config.ts` | KEEP — J12 | Node worker tests run in the appropriate environment. |
| `packages/workflow-model/vitest.coverage.config.ts` | KEEP — J12 | Includes all source; missing lifecycle cases remain open despite passing thresholds. |

## WQ-010 — retain evaluator ownership until worker termination completes

**P2 FIX, controlled lifecycle reproduction.** `expressions/evaluator.ts`,
`shutdown`, `#run` and its private `finish` callback.

```ts
this.#workers.delete(worker);
try { await worker.terminate(); }
finally { complete(); pending.resolve(result); }
```

The worker disappears from shutdown's set before termination completes. Using
the existing `workerFactory` seam with an EventEmitter-compatible fake and a
deferred termination promise, emit ready, started and successful result; then
await shutdown before releasing termination. Observed:

```json
{"shutdownReturned":true,"evaluationSettled":false,"terminateCalls":1}
```

After resolving termination the evaluation succeeds. This proves the ownership
gap at the supported seam, not a measured real-worker leak. The related
`void finish(...)` calls also have no rejection handler if terminate rejects;
`finally` settles the request but does not consume finish's rejection. Test
that case explicitly before claiming production impact.

Plan: keep a tracked completion/termination promise for every admitted worker
until its cleanup is settled. Deduplicate termination across finish/shutdown;
shutdown waits for both active and already-finishing work and caches its own
promise. Preserve the selected result's success/cancellation precedence and
release pool capacity only after the hard-stop attempt. Handle cleanup rejection
deliberately without an unhandled rejection, while leaving the initiating
evaluation outcome stable and exposing shutdown failure as appropriate.
Do not add a shared app lifecycle framework or replace one-shot isolation.

Tests through `JsonataEvaluator`: result then deferred terminate then shutdown;
abort then shutdown; repeated shutdown; sync construction/postMessage failure;
termination rejection; queued work never starts after shutdown; no late result
or capacity oversubscription. Keep real compiled-worker termination/restart
tests. Add malformed response order checks (duplicate started, result before
start, duplicate ready) and preserve the original deadline rather than allowing
it to be reset by repeated started messages. The production worker sends one
started message; this is protocol robustness, not an asserted hostile worker
escape. Run workflow-model tests/typecheck and evaluator-owner shutdown cohorts
in API/worker. Coordinate PF-07 only for hostile context error normalization.

## WQ-011 — make browser and server draft admission limits agree

**P2 FIX + bounded traversal REFACTOR, reproduced.**
`graph-contract.ts:228` and `graph/preflight.ts:144`.

With an otherwise valid one-node graph whose config has 65 object levels:

```json
{"browser":true,"server":false,"serverCode":"json_value_depth"}
```

Browser preflight applies only whole-document input depth (256), whereas the
server also applies config/literal depth 64 and reserved mapping-key rules.
This is not the intentional distinction between an incomplete draft and a
publishable DAG. Both APIs are draft admission interfaces; identical structural
data should not receive contradictory limit decisions.

Plan: share browser-safe **admission facts**, including config/literal depth
and mapping-key policy, with separate browser-Zod and server-code/path error
adapters. Preserve existing diagnostics for non-finite numbers and aggregate
counts, which tests explicitly distinguish. Keep semantic DAG/definition checks
out of draft parsing. Do not import Node Buffer, crypto or server-only errors
into the browser path.

Replace the browser's value-plus-`exits`/`ancestors` bookkeeping with explicit
`{kind:'enter', value, depth}` / `{kind:'exit', value}` frames, as used by the
server, so an actual repeated value is never mistaken for a scheduled exit.
The tested simple cycle currently rejects rather than hanging; no infinite-loop
claim is made. Explicit frames make cycle classification and accounting easier
to prove. Before allocating array index lists/frames, reject lengths whose
minimum JSON byte footprint already exceeds the remaining budget. The current
browser `Array.from({length: value.length})` can allocate far beyond the 1MiB
contract before rejection. No huge-allocation probe was run.

Acceptance: browser/server success agrees for exact/over config and literal
depth, nested graph totals, reserved keys, cyclic/shared references, arrays and
UTF-8 bytes; precise existing error adapters stay stable. Early oversize-array
tests should use bounded fixtures or observable iteration counters, not allocate
billions of entries. Retained checksums, schema documents and ETags for valid
inputs remain identical. Run package contract, graph, retained golden tests and
generated contracts checks. Implement together with WQ-012 to inspect one snapshot.

## WQ-012 — protect graph safe parsing from secondary inspection and rereads

**P2 FIX, two reproduced paths.** `graph/preflight.ts:311` catch and
`graph-contract.ts:296` preflight/structural pipeline.

Server: a root proxy's ownKeys trap throws a proxy whose getPrototypeOf throws.
`safeParseWorkflowGraphDraft` then throws `Error('secondary trap')` from its
`instanceof` checks instead of returning `{success:false}`. This is the same
mechanism as SDK WQ-004, applied at a separately exported safe-parse interface.

Browser: a proxy around `{schemaVersion:1,nodes:[],edges:[],settings:{}}` with
ordinary descriptors and a throwing `get` trap passes preflight but throws
`Error('structural get escaped')` when Zod rereads it. Inspecting the original
object and subsequently parsing it are not the same snapshot.

Plan: admitted own-data snapshot flows into structural parsing; do not return
the original proxy after a Boolean preflight. Preserve historical handling of
undefined optional fields and enumerable fields deliberately. Failure adapters
must never inspect arbitrary exceptions without their own containment; prefer
trusted internal reason records and fresh stable boundary errors. Preserve
ordinary Zod and `WorkflowGraphContractError` diagnostics where safe, not raw
hostile `.message`/`.cause`. No repository-wide generic error framework.

Tests: root and nested reflection errors; thrown/revoked proxy; getter-bearing
objects; descriptors that admit safe data but reads throw; no secondary traps
executed by error formatting; both public safe entrypoints return failed parse
without throwing. Keep schema generation routed through the explicitly
structural schema rather than weakening runtime admission. Run workflow-model,
contracts and API draft-validation tests. WQ-011/WQ-012 are one coherent
implementation unit with independent assertions; SDK WQ-003 is analogous but
has different repeated-reference/depth semantics and must not be blindly reused.

## WQ-013 — pin own-array lookup and strengthen mapping evidence

**P3 CONDITIONAL/TEST.** `json-path.ts:68`, `test/mapping.test.ts`,
`test/graph.test.ts` cross-body mapping assertion.

Object segments explicitly check `Object.hasOwn`; numeric array segments read
`value[segment]` after only an array/length check. A sparse array with an inherited
index can therefore resolve inherited data through the pure resolver. Normal
canonicalized SDK/engine inputs are dense and already exclude this; do not claim
a production prototype injection path. The public resolver's documentation and
existing inherited-object test nevertheless claim own-property behavior.

Add an inherited-array-index test, then use `Object.hasOwn(value, segment)` in
the numeric branch if the documented own-property contract includes direct
array callers. Keep dense arrays, zero index, out-of-range/missing and present
null semantics unchanged; do not invoke arbitrary getters as part of a broader
unrequested hostile-object contract. If explicitly restricted to canonical JSON,
document that precondition and retain implementation, but keep the contract
decision visible. No new path syntax or numeric coercion policy.

Separately replace the duplicate identical `arrayContaining` matchers in the
cross-body mapping test with assertions for both offending paths and exact
issue count. Repeated equal matchers do not prove two distinct violations.
Run mapping, graph, Validate pure/runtime tests. Keep this below confirmed fixes.
