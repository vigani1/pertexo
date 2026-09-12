# Core nodes — file-by-file judgment

Primary review: all 69 files read in full; **7 files / 96 existing tests passed**.
One additional current-source validation probe reproduced WQ-008. Tests consume
existing built workspace dependencies; no new full build or provider calls.

Each path below is repository-relative. Browser manifest/validation/executor
separation is intentional; file count alone is not a reason to merge these.

| File | Judgment | Reason / required work |
| --- | --- | --- |
| `packages/nodes-core/src/condition/definition.ts` | KEEP — J01, J13 | Exact Boolean branch ports and policy/ABI identity are explicit. |
| `packages/nodes-core/src/condition/executor.ts` | KEEP — J02, J06 | One Boolean selection after registry validation; the input cast reflects the existing erased executor registration interface. No extra predicate abstraction needed. |
| `packages/nodes-core/src/condition/validation.ts` | KEEP — J06 | Strict empty config, Boolean input and two literal output ports. |
| `packages/nodes-core/src/condition/index.ts` | KEEP — J13 | Browser facade excludes executor implementation. |
| `packages/nodes-core/src/manual/definition.ts` | KEEP — J01 | Trigger ports/manual capability and frozen metadata match the initial release. |
| `packages/nodes-core/src/manual/executor.ts` | KEEP — J05 | Intentional input passthrough; registry owns JSON admission and copying. |
| `packages/nodes-core/src/manual/validation.ts` | KEEP — J06 | Empty config and bounded arbitrary JSON are appropriate to Manual. SDK WQ-003 applies through the imported validator. |
| `packages/nodes-core/src/manual/index.ts` | KEEP — J13 | Browser facade excludes executor. |
| `packages/nodes-core/src/set/definition.ts` | KEEP — J01 | JSONata policy identifies already-resolved transformation input; executor need not re-evaluate expressions. |
| `packages/nodes-core/src/set/executor.ts` | KEEP — J05 | Passthrough is this node's intended responsibility, not a missing mapping engine. |
| `packages/nodes-core/src/set/validation.ts` | KEEP — J06 | Bounded record differs deliberately from Manual's scalar-capable input. |
| `packages/nodes-core/src/set/index.ts` | KEEP — J13 | Browser-only definition/schema exports. |
| `packages/nodes-core/src/terminate/definition.ts` | KEEP — J01 | Terminal capability and absent output ports encode run termination explicitly. |
| `packages/nodes-core/src/terminate/executor.ts` | KEEP — J01, J05 | Returns input; SDK derives terminal-success from pinned capability. Avoid duplicating that decision here. |
| `packages/nodes-core/src/terminate/validation.ts` | KEEP — J06 | Strict config and bounded record output preserve terminal contract. |
| `packages/nodes-core/src/terminate/index.ts` | KEEP — J13 | Browser exports do not load executor. |
| `packages/nodes-core/src/webhook/definition.ts` | KEEP — J01, J09 | Public trigger metadata contains no endpoint key or signing secret. |
| `packages/nodes-core/src/webhook/executor.ts` | KEEP — J05 | Durable ingress validation is elsewhere; accepted input passes through. |
| `packages/nodes-core/src/webhook/validation.ts` | KEEP — J04, J09 | Comment explains why endpoint material is forbidden from config. |
| `packages/nodes-core/src/webhook/index.ts` | KEEP — J13 | Browser definition/schema surface. |
| `packages/nodes-core/src/wait/definition.ts` | KEEP — J01 | Suspension capability declares coordinator behavior. |
| `packages/nodes-core/src/wait/executor.ts` | KEEP — J07 | Does not sleep or own timers; waiting belongs to durable orchestration. |
| `packages/nodes-core/src/wait/validation.ts` | KEEP — J06, J11 | Explicit 1-second through 30-day bounds and strict config. |
| `packages/nodes-core/src/wait/index.ts` | KEEP — J13 | Browser surface excludes executor. |
| `packages/nodes-core/src/for-each/definition.ts` | KEEP/run with WQ-008 — J01, J13 | Stable retained schema fingerprint must not change during defensive validation repair. |
| `packages/nodes-core/src/for-each/executor.ts` | KEEP — J01, J05 | Returns declaration and count; coordinator owns iteration scheduling. |
| `packages/nodes-core/src/for-each/validation.ts` | FIX — WQ-008 | Recursive `z.json()` runs before bounded inspection; direct exported schema can overflow on cyclic/deep input. |
| `packages/nodes-core/src/for-each/index.ts` | KEEP — J13 | Public schema export makes direct admission behavior relevant. |
| `packages/nodes-core/src/switch/definition.ts` | KEEP — J01 | Stable finite case ports plus default reflect persisted graph bindings. |
| `packages/nodes-core/src/switch/executor.ts` | KEEP — J02 | `find` plus nullish default clearly preserves first matching case; do not sort cases. |
| `packages/nodes-core/src/switch/validation.ts` | KEEP — J01, J06 | Unique IDs but duplicate equal-values allowed intentionally for ordered first match. Literal port tuple earns its verbosity through enum/type reuse. |
| `packages/nodes-core/src/switch/index.ts` | KEEP — J13 | Browser facade. |
| `packages/nodes-core/src/parallel/definition.ts` | KEEP — J01, J14 | V1/V2/V3 additive identities preserve old output grammar while later versions label runtime-only refinements. |
| `packages/nodes-core/src/parallel/executor.ts` | KEEP — J02 | Ordered branch projection is concise; versioned registrations correctly reuse unchanged execution. |
| `packages/nodes-core/src/parallel/validation.ts` | KEEP — J03, J06 | Two config checks encode distinct uniqueness/concurrency constraints; V2 output uniqueness cannot be backported silently into V1. |
| `packages/nodes-core/src/parallel/index.ts` | KEEP — J13 | Browser schemas/manifests only. |
| `packages/nodes-core/src/merge/definition.ts` | KEEP — J01, J14 | Frozen retained and successor manifests make version-specific behavior visible. Repeated explanatory strings are fingerprinted metadata, not free cosmetic edits. |
| `packages/nodes-core/src/merge/executor.ts` | KEEP — J05 | Merge decision/ledger is settled by engine; executor validates via registry then passes through. |
| `packages/nodes-core/src/merge/validation.ts` | KEEP — J01–J03 | Discriminated join policy is clearer than flags. Settled-ledger, uniqueness, canonical order and selected-arrival checks represent real independent invariants. `output: unknown` is bounded by SDK invocation admission, not asserted safe for arbitrary direct serialization. |
| `packages/nodes-core/src/merge/index.ts` | KEEP — J13 | Browser facade. |
| `packages/nodes-core/src/schedule/definition.ts` | KEEP — J01, J14 | V2 strict grammar/envelope and V3 runtime-semantics description are additive; retain old fingerprints. |
| `packages/nodes-core/src/schedule/executor.ts` | KEEP — J05 | Trigger materialization/scheduling is not duplicated in executor. |
| `packages/nodes-core/src/schedule/validation.ts` | KEEP — J01, J06 | Legacy regex acceptance is pinned by tests; strict successors use actual parser with deterministic reference date. Canonical timezone policy is an existing product constraint, not permission to add aliases/UTC in a cleanup. |
| `packages/nodes-core/src/schedule/index.ts` | KEEP — J13 | Browser facade includes schemas, not runtime scheduling. |
| `packages/nodes-core/src/validate/definition.ts` | KEEP — J01, J09 | Explicit fixed-issue, privacy and truncation semantics accurately describe implementation. Runtime-only descriptions are versioned contract content. |
| `packages/nodes-core/src/validate/executor.ts` | KEEP — J05, J08 | Maps pure cancellation to SDK cancellation and validates direct executor input; do not remove reparsing merely because registry also validates without deciding the direct executor contract. Catch inspection shares the broader hostile-object concern but ordinary registry input is canonical; no additional confirmed defect assigned here. |
| `packages/nodes-core/src/validate/issue-metadata.ts` | KEEP — J06 | One immutable metadata tuple derives public literal maps and ordered code tuple. Mapped/Extract types preserve key-specific literals and isolate `Object.fromEntries` casts; replacing them with wide `Record<string,string>` loses useful guarantees. |
| `packages/nodes-core/src/validate/semantics.ts` | REFACTOR — WQ-009; otherwise KEEP | Ordered guards make one-issue precedence clear. Inline Unicode counting and its early-exit condition distract from rule interpretation; extract only that substantive algorithm. |
| `packages/nodes-core/src/validate/validation.ts` | KEEP — J03, J06 | Six explicit constraint/type checks and three lower/upper checks are easy to audit and produce field-specific issues. A heterogeneous constraint table would add dynamic indexing without eliminating meaningful conditions. Output flags are runtime-refined to valid combinations. |
| `packages/nodes-core/src/validate/index.ts` | KEEP — J13 | Intentionally exports pure preview semantics; no executor/server import. |
| `packages/nodes-core/src/definitions.ts` | KEEP — J01, J13 | Explicit version-to-schema wiring is useful contract documentation; avoid dynamic name conventions or inferred latest versions. |
| `packages/nodes-core/src/registrations.ts` | KEEP — J01, J05 | Private bundle construction detects missing/extra/duplicate executor ownership and preserves definition order. One-to-one is a core-package invariant, not a new SDK-wide restriction. |
| `packages/nodes-core/src/registry.ts` | KEEP — J01, J14 | Baseline and lifecycle-only successor are historical behavior, intentionally only the first three definitions. |
| `packages/nodes-core/src/server.ts` | KEEP — J01, J05 | Baseline-or-next-successor contract differs from platform's shipped-history allowlist; do not unify them because code looks similar. Maps localize exact implementation binding. |
| `packages/nodes-core/src/server-only.ts` | KEEP — J13 | Early runtime guard complements exports. |
| `packages/nodes-core/src/index.ts` | KEEP — J13 | Explicit public browser export inventory. |
| `packages/nodes-core/src/policies.ts` | KEEP — J01 | Two fixed versioned policy identities; no premature policy engine. |
| `packages/nodes-core/test/data-nodes.test.ts` | KEEP — J12 | Exercises public registry, mutation avoidance, terminal success and record/scalar distinctions. Shared signal is never aborted; cancellation test has its own controller. |
| `packages/nodes-core/test/node-execution.test.ts` | KEEP — J12 | Named fixture matrix exercises erased registrations through SDK parsing, rather than bypassing it with casts. V3 composition is also covered in catalog tests. |
| `packages/nodes-core/test/orchestration-nodes.test.ts` | TEST — WQ-008; otherwise KEEP | Negative state matrices retain V1/V2 distinctions. Add cyclic/deep direct For Each admission and exact limits; current 1,001-item rejection does not prove bounded recursion. |
| `packages/nodes-core/test/package-contract.test.ts` | KEEP — J12, J13 | Independent 18-identity inventory and transitive browser dependency check; guards registration removal. |
| `packages/nodes-core/test/retained-registry.test.ts` | KEEP — J12 | Recursive freeze helper has a visited set; explicit unsupported definition/executor fixtures test distinct failure order. |
| `packages/nodes-core/test/trigger-nodes.test.ts` | KEEP — J12 | Valid/invalid cron matrix and explicit legacy acceptance prevent accidental behavior changes to retained releases. |
| `packages/nodes-core/test/validate.test.ts` | TEST — WQ-009; minor naming cleanup | Strong fixed-message mismatch and independent expected-value tests supplement preview/runtime parity. `invalidCases` has descriptions that the `%s` title currently ignores; use description in parameterized titles while touching the file. |
| `packages/nodes-core/package.json` | KEEP — J13 | Runtime dependencies correspond to SDK, path semantics, cron grammar and Zod; explicit server subpath. |
| `packages/nodes-core/tsconfig.json` | KEEP — J13 | Compiled NodeNext/DOM contract with correct SDK/model references. |
| `packages/nodes-core/tsconfig.test.json` | KEEP — J12, J13 | Tests and config included without production emission. |
| `packages/nodes-core/vitest.config.ts` | KEEP — J12 | Package-local Node runner; no unnecessary mocks. |
| `packages/nodes-core/vitest.coverage.config.ts` | KEEP — J12 | All source measured; passing function coverage does not refute WQ-008. |

## WQ-008 — bound For Each input before recursive schema traversal

**P2 FIX, reproduced at exported schema.** `src/for-each/validation.ts:6`.

```ts
const itemsSchema = z.array(z.json()).max(1_000).superRefine((items, context) => {
  // bounded JSON check occurs only after z.json recursively parsed each item
});
```

Read-only current-source probe:

```ts
const cyclic = {};
cyclic.self = cyclic;
CORE_FOR_EACH_INPUT_SCHEMA.safeParse({ items: [cyclic] });
// throws RangeError: Maximum call stack size exceeded
```

A 2,000-level nested ordinary object likewise throws instead of returning a
failed parse. The public SDK registry first canonicalizes its envelope and
therefore already rejects this before the node schema; do not claim the normal
worker execution path bypasses its bounds. Direct browser schema consumers are
the affected interface, consistent with the package's exported validation role.

Plan: perform the shared iterative bounded JSON check before `z.json()` can
descend, then use the existing structural schema on the admitted snapshot.
Coordinate with SDK WQ-003 to avoid duplicating a third JSON inspector. Preserve
the public schema's output shape, strictness, item limit, `iterationCount`
equality, and current JSON Schema document. Verify Zod projection for the chosen
preflight composition before changing registrations; if it alters retained
manifest fingerprints, stop and select a compatible composition or an explicitly
authorized additive version. Do not regenerate historical golden digests.

Tests: exported input/output schemas reject cyclic and excessive-depth values
without throwing; exact depth/member/byte boundaries and 1,000/1,001 items;
incorrect iteration count; input remains unchanged; registry still emits stable
invalid-JSON/input/output errors. Use bounded local fixtures, not unbounded fuzz
or process-wide stack changes. Run nodes-core, SDK, catalog golden-history and
browser dependency tests. No network qualification is needed.

## WQ-009 — name bounded code-point counting without changing rule precedence

**P3 focused REFACTOR/TEST.** `src/validate/semantics.ts:75–94`.

Current stop condition inside rule interpretation:

```ts
if ((rule.maxLength !== undefined && length > rule.maxLength) ||
    (rule.maxLength === undefined && rule.minLength !== undefined &&
     length >= rule.minLength)) break;
```

This is correct for validated bounds, but requires a reader to reason about
Unicode surrogate width, stop conditions and validation precedence together.
Extract a private `countCodePointsUpTo(value, stopAfter)` operation: count until
`maxLength + 1` if maximum is present, otherwise until `minLength` if present;
skip counting entirely when no length constraint exists. Keep safe-integer
arithmetic capped appropriately and avoid allocating `Array.from(value)` or
splitting the string. The rule body retains minimum-before-maximum issue order.

Tests through `evaluateCoreValidate`: zero bounds, exact and one-over maximum,
minimum-only early success, both constraints, astral symbols, combining marks
(code points, not graphemes), lone surrogates, and long no-length-constraint
string. Existing issue precedence, fixed messages, missing-vs-null, truncation
and cancellation assertions remain. Do not expose the helper, change length
units, add a grapheme library, or claim measured speedup. Run nodes-core tests
and typecheck. This is independent of WQ-008 and lower priority than fixes.
