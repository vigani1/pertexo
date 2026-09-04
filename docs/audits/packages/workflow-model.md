# `@pertexo/workflow-model` implementation and architecture audit

## Review identity and conclusion

- **Audited commit:** `7e4b37840a2b86c591046e16f1de834e8da2db79`
- **Audited tree:** `8481ebf86f4b36ff70687f86a2bb7933a00d65b8`
- **Production scope:** all 10 source files and all 2,475 physical source
  lines.
- **Test scope:** all nine tracked test/fixture files and all 1,924 physical
  lines, plus every production consumer in contracts, API, database,
  workflow-engine, and worker, package scripts, CI, and applicable integration
  seams.
- **Architecture sources:** the authoritative backend plan and ADRs 002, 005,
  007 through 011, 016 through 022, and 025.
- **Audit status:** complete for the pinned tree.
- **Implementation status:** two high-priority publish/evaluator defects, six
  medium contract/design/control gaps, and three lower-priority API or
  maintainability improvements remain open.

This is a necessary, high-Leverage domain Module. It owns the versioned authoring
graph, canonical execution identity, semantic graph validation, mapping
resolution, restricted JSONata policy, retained V1 verification, invocation
identity, and failure-notification value contracts. The dependency direction is
good: browser-safe contracts depend only on Zod, while cryptography,
canonicalization, JSONata, and worker threads stay behind server-only exports.

Much of the implementation is unusually careful. Unknown definitions remain
readable but unpublishable; drafts and published graphs are distinct;
checksums exclude only authoring metadata and collection order; nested For Each
expansion is bounded; canonical JSON rejects accessors, cycles, and host
objects; expression syntax is allowlisted before isolated execution; and the
tests contain exact boundary, golden identity, cross-process determinism, hard
timeout, cancellation, and retained-version cases.

The important remaining problems are cross-layer ones. Publish validation does
not reject `node_output` mappings to missing or non-upstream nodes, while the
engine rejects them only when a run is already executing. The evaluator's
purported two-worker pool actually creates and terminates a fresh worker thread
for every evaluation; its evidence labels concurrency as worker count, and a
synchronous Worker-construction failure rejects outside the typed result
contract while permanently consuming an active slot. Browser and server graph
admission also disagree on aggregate nested node/edge limits, and graph
validation can produce more issues than the API response schema accepts.

## Evidence collected

The review used complete source/test reading, export and internal-callable
inventory, repository-wide consumer tracing, plan/ADR comparison, build,
typecheck, ESLint, unit tests, explicit V8 coverage, focused runtime
counterexamples, and a local evaluator throughput probe.

| Check | Result |
| --- | --- |
| `pnpm --filter @pertexo/workflow-model test` | 8 files and 59 tests passed |
| `pnpm --filter @pertexo/workflow-model typecheck` | Passed |
| `pnpm --filter @pertexo/workflow-model build` | Passed |
| ESLint with repository 8 GiB Node heap | Passed |
| Direct ESLint with default Node heap | Aborted near 4 GiB; repository command correctly supplies 8 GiB |
| Ad hoc package-source V8 coverage | 88.70% statements, 80.44% branches, 96.07% functions, 91.70% lines |
| Browser/server graph parity | browser schema accepted 1,001 aggregate nested nodes; server draft parser rejected it |
| Canonical array counterexample | inherited sparse element accepted; enumerable string and symbol properties silently discarded |
| Validation cardinality | 102 duplicate-ID nodes produced 101 issues; API response contract allows at most 100 |
| Expression throughput probe | 100 trivial expressions took about 361 ms at concurrency four on this host |
| Worker construction | source creates one `Worker` inside every `#run`; the “workers: 2” proof field records configured concurrency, not created workers |

The throughput number is diagnostic evidence from one development machine, not
a production SLO. It proves the implementation shape and gives a baseline; it
does not alone choose a worker-pool design.

## Architecture, ownership, and dependency direction

### Public seams

The package presents three kinds of Interface:

- browser-safe `./graph-contract`, `./failure-notification`, and
  `./assert-never` exports;
- server-only graph/canonical/mapping/expression exports and a server-only root;
- compatibility and retained-version helpers consumed by persistence and the
  execution compiler.

That split is correct. `packages/contracts` imports the browser-safe graph and
notification schemas without pulling `node:` APIs or the execution engine.
Database code owns persistence but delegates graph meaning and identity here.
The workflow engine consumes parsed graphs and mappings without redefining the
authoring model. There is no dependency cycle back from workflow-model into
applications, database, contracts, node-sdk, or workflow-engine.

### Depth and Locality

The conceptual Module is deep: a relatively small graph Interface hides
schema, bounded input defense, structured topology, compatibility,
canonicalization, and execution identity. The file layout is less deep than the
conceptual design:

- `graph.ts` is 926 lines and owns input preflight, draft parsing, semantic
  validation orchestration, catalog compatibility, integration usage,
  executable projection/checksum, retained V1 parsing, draft ETags, and
  invocation keys.
- `expressions.ts` is 610 lines and owns policy vocabulary, dependency-AST
  validation, an embedded untyped worker program, admission queueing, process
  lifecycle, cancellation, limits, and result normalization.

These are not “too large” merely by count. They contain real owner boundaries
that already change for different reasons and deserve internal modules. Keep
existing subpaths as facades while moving implementation into cohesive seams:

```text
src/
  graph-contract.ts                    browser-safe wire schema
  graph.ts                             server public facade
  graph/input-preflight.ts
  graph/semantic-validation.ts
  graph/compatibility.ts
  graph/executable-identity.ts
  graph/retained-v1.ts
  graph/invocation-identity.ts
  expressions.ts                       server public facade
  expressions/policy.ts
  expressions/ast-validation.ts
  expressions/evaluator.ts
  expressions/worker-runtime.ts        compiled, typed worker entry
  mapping.ts
  canonical-json.ts
  failure-notification.ts
```

Do not introduce repository-generic graph or JSON utility packages. These
implement domain policy and belong here. Preserve the small number of public
subpaths; the proposed files are internal ownership, not more public API.

## Complete production-code review

### `src/assert-never.ts`

This tiny browser-safe helper has one real consumer in the failure-notification
delivery switch. It is useful and correctly throws at runtime if an external
value violates compile-time exhaustiveness. A package just for this helper
would be overabstraction; the existing subpath is low-cost but could instead
live with the notification contract if no second consumer appears.

### `src/canonical-json.ts`

Object canonicalization is strong: keys sort ordinally, output uses
null-prototype objects so `__proto__` remains data, numbers are finite and `-0`
normalizes to zero, accessors/symbols/host prototypes/cycles are rejected, and
shared non-cyclic values are allowed. `inspectJsonValue` reports serialized
UTF-8 bytes, container depth, and members from the canonical form.

Array handling is inconsistent with object handling. Sparse admission uses
`index in value`, so an inherited numeric property satisfies a missing own
element and is copied into canonical data. The array branch returns before
checking symbol or non-index enumerable properties; those are silently dropped.
This means canonicalization accepts host-observable input that its own plain
object policy rejects (WM-005). Use own data descriptors for each index and
reject unexpected own keys/symbols, or explicitly document JSON.stringify-like
discard semantics and make all JSON boundary implementations agree.

The normalizer and inspection visitor are recursive and unbounded by this
Interface. Graph parsing preflights iteratively and expression evaluation
catches errors, so current consumers are protected from process failure, but a
direct public caller can receive `RangeError` for deeply nested input. Either
make the primitive iterative or document that callers must enforce a boundary
first (WM-010).

### `src/graph-contract.ts`

This is the right browser-safe owner for graph shapes and editor-visible
limits. Zod contracts are strict, recursive, versioned, and constrain execution
duration and loop controls. The iterative preflight prevents a deep recursive
Zod parse from exhausting the stack and enforces a one-MiB input budget.

The schema caps `nodes` and `edges` separately in every graph object, not across
the root and all structured bodies. The server parser performs the missing
aggregate walk. A 153,289-byte graph with one root node and 1,000 body nodes
therefore passes `workflowGraphSchema` but fails `parseWorkflowGraphDraft`.
Because this schema is deliberately shared with browser/API contracts, the
editor and HTTP boundary do not actually receive the same limit behavior
(WM-003).

Move aggregate counting into the browser-safe preflight so both Interfaces
reject identically. Keep server semantic checks separate: drafts are allowed to
be structurally valid while temporarily cyclic or definition-incompatible.

`JsonValue` is restated here because the browser-safe surface cannot import the
server-guarded canonical module. The types are structurally equivalent. This is
intentional boundary duplication, not a finding.

### `src/graph-validation.ts`

Semantic validation is mostly cohesive. It indexes globally unique node IDs,
keeps ordinary edges within a structured body, detects cycles, enforces loop
bounds and exact For Each ownership/ports, requires a nonempty single-sink body,
prevents mappings from crossing structured seams, and calculates nested
worst-case expansion independently from loop iterations.

`validateMappings` only reports a `node_output` problem when the referenced
node exists somewhere globally but outside the current body. It does nothing
when the ID does not exist at all, and it does not prove the referenced node is
a direct upstream connected by an edge. The workflow engine later requires
exactly that condition and returns `attempt_invalid` at execution time. Thus a
graph can pass publication and compile successfully but be guaranteed to fail
when the affected node runs (WM-001).

Build the incoming-node set for each target during validation. Every
`node_output` mapping must reference a node in the same local graph and, per the
engine's actual contract, a direct incoming source. Report a dedicated issue
code/path at publish time and share the topology predicate with compilation so
the two layers cannot drift.

Recursive DFS is bounded by the 1,000-node contract and structured recursion by
32, so it is intentional complexity. Sorting only traversal roots is enough for
validity; issue ordering for cycles may still depend on edge order. If response
or snapshot determinism requires stable issue order, sort adjacency once.

### `src/graph.ts`: parsing and semantic reports

The two-stage parser is security-conscious. It first counts bytes and validates
ordinary data descriptors without invoking accessors, then applies targeted JSON
depth checks, Zod structure, and aggregate resource limits. `safeParse` converts
unexpected reflection errors into a stable graph contract error. Draft parsing
deliberately does not enforce publish semantics, supporting incremental editing.

There are two overlapping browser/server preflight implementations. Their
different goals justify some separation, but shared invariants have already
drifted (WM-003). Define a browser-safe admission result that includes bytes and
aggregate counts, then layer the richer server error taxonomy on it rather than
maintaining two independent walkers.

`validateWorkflowGraph` accepts arbitrary `Partial<WorkflowGraphLimits>` without
validating finite, positive, safe values. The parameter is mainly a test seam
but is public production API. Invalid overrides can disable limits or yield
misleading results. Parse overrides or move them behind an explicit testing
factory (WM-010).

The validator accumulates every issue. With 102 duplicate nodes it returns 101
issues. The API serializer passes that array to a response schema capped at
100, causing response serialization to throw instead of returning the useful
validation report (WM-004). Set one shared maximum, stop collecting after the
cap, and expose truncation explicitly if clients need to know more exist.

### `src/graph.ts`: compatibility and integration usage

Compatibility uses exact definition key/version pairs, deduplicates unknown
identities, sorts deterministically, and can use the complete node release
fingerprint. Projection metadata deliberately does not alter compatibility
identity. This follows the plan and avoids latest-version fallback.

Integration usage is a derived index rather than a second graph authority. It
walks nested bodies, requires declared connection slots, deduplicates stable
provider/operation/connection triples, and sorts them. In production it is
called after publish parsing with a node-catalog-produced catalog, so the typed
catalog is a valid trusted input. If external catalog ingestion is added, this
function must gain runtime catalog validation rather than trusting its
TypeScript shape.

### `src/graph.ts`: executable and retained identities

Executable projection correctly excludes canvas position, label, and node/edge
array order while retaining stable IDs, topology, definitions, configuration,
mappings, connections, disabled state, settings, and every structured field.
Domain-separated SHA-256 and versioned prefixes are appropriate. Cross-process
goldens protect byte identity.

Retained V1 parsing fails closed on envelope/checksum corruption and explicitly
returns `executable: false`; it does not require retired definitions to remain
active. This is an excellent compatibility seam and should remain isolated
during the file split.

Draft representation tags validate workflow/revision/fingerprint inputs and
cover graph plus compatibility identity. Invocation identity validates ordered
branch/iteration scope and intentionally excludes run ID from the digest
because database uniqueness is `(workflow_run_id, invocation_key)`. Those
choices match ADRs 007, 008, 011, 017, 019, and 020.

Returned parsed graphs are TypeScript-readonly but not recursively frozen. That
is acceptable while callers treat them as values and persistence serializes
within one call; deep freezing a one-MiB graph would add cost. Preserve this as
a documented ownership rule and use mutation tests at persistence/checksum
seams rather than automatically freezing everything.

### `src/mapping.ts`

The restricted path grammar is intentionally small, deterministic, and safe:
root, identifier properties, numeric indices, and quoted properties with only
quote/backslash escapes. Resolution distinguishes missing from JSON null and
uses own-property checks.

`resolveValueSource` gives literal, run, node, structured, and expression
sources one clear Seam and propagates cancellation. Its injection type is the
concrete `JsonataEvaluator`, whose private fields make structural substitutes
invalid. The package test must cast a small fake through `unknown`. Depend on a
minimal `ExpressionEvaluator` Interface with `evaluate()` instead; keep the
concrete worker implementation behind it (WM-006).

The module-level evaluator is convenient and creates no idle workers, but its
lifecycle and metrics cannot be composed by applications. Let the execution
composition root own a singleton evaluator explicitly so shutdown, saturation,
and future telemetry are visible. Avoid creating an evaluator per mapping.

### `src/expressions.ts`: policy and AST boundary

The policy is narrow and explicit. Source bytes, AST nodes/depth, input/output
bytes/depth/members, concurrency, queueing, memory, stack, and time are bounded.
The AST walker denies assignment, lambdas, transforms, regex, descendant
traversal, dynamic callables, arbitrary variables, path tuple/group metadata,
and forbidden host roots. Only a pinned pure built-in set is callable.

The JSONata dependency AST is treated as untrusted library output and checked
before traversal. Package version is pinned and diagnostics/tests detect AST
shape drift. The worker receives only canonical context fields converted to
null-prototype objects. Timeout/abort terminates computation, discards late
messages, and later evaluation remains available. These are strong controls.

### `src/expressions.ts`: worker lifecycle and performance

`JsonataEvaluator` calls itself a bounded pool, but it pools only admission
slots. Every `#run` constructs a new Worker, imports JSONata, evaluates one
expression, and terminates. The 101-evaluation proof reports `workers: 2`, but
that field is configured concurrency; source creates 101 workers. This
contradicts the ADR's evidence wording and hides material per-mapping startup
cost (WM-002).

Choose one honest design. If process isolation requires one-shot workers, name
and instrument it as a bounded one-shot executor and record actual worker
creations. If healthy workers can be reused safely, implement a real fixed pool
whose workers accept multiple messages, reset all evaluation state, and are
replaced after timeout/abort/crash. Prove no cross-request state or bindings,
then benchmark large workflows. Do not optimize away hard termination.

The 100 ms deadline begins only after the worker imports JSONata, receives the
message, canonicalizes context again, and posts `started`. This follows the ADR's
evaluation deadline but leaves startup unbounded. A worker that neither errors,
exits, nor posts ready holds an active slot forever. Add a separate bounded
startup/readiness deadline (WM-007).

`#drain` increments active count before calling `#run`. If `new Worker(...)`
throws synchronously, the outer `evaluate()` promise rejects instead of
returning typed `evaluation_failed`; the `.finally` decrement is never attached,
so capacity remains permanently consumed. Catch construction and all supervisor
setup failures, resolve the typed result, and decrement exactly once (WM-002).

The worker program is a dense JavaScript string. Tests execute it, but
TypeScript, ESLint, imports, navigation, and coverage cannot analyze its logic.
Move it to a compiled worker-runtime source module and reference its emitted URL
(WM-008). Keep the worker entry private and test the built artifact, not merely
the TypeScript source path.

### `src/failure-notification.ts`

These browser-safe schemas keep destinations, terminal context, and delivery
results channel-neutral and exclude raw provider responses, credentials, input,
and actors. IDs, timestamps, safe codes, counts, and text are bounded. Email
domain normalization is deterministic.

The delivery-result schema is structurally strict but admits contradictory
states: `delivered` with `possiblyDispatched: false`, `definite_failure` with
`true`, `outcome_unknown` with `false`, or provider references on failures.
Worker code currently constructs coherent combinations, but database parsing
uses this schema as a trust boundary. Encode the valid state machine as a
discriminated union so impossible combinations cannot be persisted or replayed
(WM-009).

`FAILURE_NOTIFICATION_CONTEXT_MAX_BYTES` is not directly applied by the schema.
Individual maxima keep current valid objects comfortably below it, and the
database performs canonical context bounds. Add a test proving the maximum
schema-valid instance remains within the advertised aggregate constant, or
make aggregate enforcement explicit.

### `src/index.ts` and `src/server-only.ts`

The server-only guard and NodeNext `.js` specifiers are correct. The root
wildcard facade is easy to use but no production consumer imports the root;
all use purpose-specific subpaths. Prefer explicit named exports in the facade
so newly added internals do not silently become public. Keep existing public
symbols compatible until consumer migration is complete (WM-011).

## Tests, coverage, and CI

### Test quality

The package suite is useful and behavior-oriented:

- canonical JSON tests cover sorting, bytes, cycles, sparse arrays, host
  prototypes, accessors, symbols, non-finite numbers, and undefined;
- expression tests cover dependency AST shape, every allowlisted built-in,
  denied constructs, exact policy boundaries, real worker results,
  context projection, timeout, cancellation, saturation, shutdown, restart,
  preview/runtime parity, and deterministic checksums;
- graph tests cover DAGs, IDs, edges, cycles, nested loops, topology, ports,
  body seams, expansion, schema versions, and invocation identity;
- public-contract tests cover exact structural/depth/byte limits, draft versus
  publish semantics, compatibility, executable identity inclusions/exclusions,
  integration usage, and ETag goldens;
- retained tests use a real historical fixture and fail closed;
- package-contract tests prove browser/server import boundaries;
- notification tests prove safe bounded fields.

The tests missed the exact failures in WM-001 through WM-009: unknown or
non-upstream mappings, aggregate browser/server parity, issue cardinality,
hostile array properties, worker construction/startup failure, actual created
worker count, structural evaluator injection, and impossible notification
states.

The evaluator performance test records elapsed time and asserts only that it is
positive. That is evidence logging, not a regression gate. ADR 005 records an
836.15 ms historical result. Add a deliberately tolerant platform-independent
budget or a benchmark trend artifact, and report actual worker creations,
startup/evaluation time, queue wait, timeout count, and peak active workers.

### Coverage and CI

CI runs workflow-model unit tests in the core matrix, and downstream API,
database, engine, and worker suites exercise its integrations. The package has
no `test:coverage` script or threshold and is absent from the root critical
coverage set. Audit coverage was 88.70% statements and 80.44% branches. This
high-Leverage boundary should have its own risk gate (WM-010).

Add per-file V8 thresholds and feed results into the repository risk report.
Prioritize adversarial graph admission, mapping topology, expression supervisor
failure, and compatibility identity over trivial getters/constants. Continue
running downstream integration tests because package coverage cannot prove
persistence or execution composition.

## Plan and ADR compliance

| Requirement | Assessment |
| --- | --- |
| Workflow-model owns graph schema/canonical identity | Satisfied |
| Browser-safe graph contract and limit constants | Structurally satisfied; aggregate limits drift from server |
| Draft remains readable before semantic validity | Satisfied |
| Published graph is executable and rejects invalid mappings | Not satisfied for missing/non-upstream node-output mappings |
| Unknown definitions never fall forward | Satisfied |
| Canonical checksum covers all execution semantics | Satisfied for V1 fields |
| Retained V1 remains verifiable and non-executable | Satisfied |
| Structured loops are bounded and scoped | Satisfied |
| Restricted, pinned JSONata capability profile | Satisfied |
| Bounded expression concurrency/queue/output/time | Evaluation bound satisfied; startup and constructor failure are not bounded/total |
| Dedicated worker and hard termination | Satisfied |
| Bounded pool and truthful two-worker proof | Not satisfied; fresh worker per evaluation and mislabeled evidence |
| Cancellation and preview/runtime parity | Satisfied |
| Failure notification safe contracts | Field safety satisfied; result-state invariants not encoded |
| Domain tests and CI | Strong tests run; package risk coverage is not enforced |

The plan is not contradicted by the component-sized audit method. It specified
the right architecture and most required proofs. The findings identify places
where implementation or evidence does not fully meet that blueprint.

## Findings and required remediation

### WM-001 — Publish accepts mappings the engine can never resolve

- **Severity:** P1
- **Classification:** Confirmed correctness defect
- **Evidence:** graph validation checks only cross-body references; it accepts
  absent or non-upstream node IDs. Engine execution later requires a direct
  upstream and throws `attempt_invalid`.
- **Impact:** a workflow can publish successfully but deterministically fail at
  runtime for a statically knowable reason.
- **Remediation:** validate every node-output mapping against same-body direct
  incoming topology and share the predicate with executable compilation.
- **Verification:** missing, downstream, unrelated, cross-body, valid direct
  predecessor, and nested-body tests at publish and execution seams.
- **Status:** Open.

### WM-002 — Evaluator is not a real worker pool and construction failure poisons capacity

- **Severity:** P1
- **Classification:** Confirmed architecture/reliability defect
- **Evidence:** every `#run` constructs/terminates a Worker; proof says two
  workers for 101 actual creations. A synchronous constructor throw bypasses
  typed results and the active-slot decrement.
- **Impact:** avoidable startup cost per mapping, misleading gate evidence, and
  permanent capacity loss under worker resource failure.
- **Remediation:** implement a proven reusable pool or explicitly specify
  bounded one-shot workers; count creations honestly; catch setup failure and
  settle/decrement exactly once.
- **Verification:** injected constructor failure, repeated recovery, actual
  creation-count assertion, isolation tests, and large-workflow benchmark.
- **Status:** Open.

### WM-003 — Browser and server graph limits disagree

- **Severity:** P2
- **Classification:** Confirmed contract defect
- **Evidence:** browser schema accepted a 1,001-node nested graph under one MiB;
  server parser rejected the aggregate count.
- **Impact:** editor/API contract validation can promise acceptance that domain
  persistence rejects.
- **Remediation:** enforce aggregate nested counts in the shared browser-safe
  preflight and reuse its result server-side.
- **Verification:** identical exact/one-over nested corpora through browser,
  contracts, API, and server parsers.
- **Status:** Open.

### WM-004 — Validation output exceeds its API response contract

- **Severity:** P2
- **Classification:** Confirmed integration defect
- **Evidence:** valid draft parsing plus 102 duplicate nodes returns 101 issues;
  API response schema allows 100 and serializer does not truncate.
- **Impact:** the validation endpoint can turn user-correctable graph problems
  into an internal serialization error.
- **Remediation:** share a maximum, cap deterministically, and signal truncation
  if needed.
- **Verification:** 100/101/many-issue endpoint tests returning a valid response.
- **Status:** Open.

### WM-005 — Canonical arrays admit inherited data and discard extra properties

- **Severity:** P2
- **Classification:** Confirmed boundary defect
- **Evidence:** inherited numeric sparse element canonicalized as data; own
  enumerable string/symbol array properties were ignored.
- **Impact:** canonical identity does not consistently represent the supplied
  JavaScript value.
- **Remediation:** require own indexed data descriptors and reject unexpected
  keys/symbols, consistently across JSON boundary packages.
- **Verification:** array subclass, prototype index, sparse, accessor, symbol,
  extra-key, `__proto__`, and proxy tests.
- **Status:** Open.

### WM-006 — Mapping depends on a concrete evaluator class

- **Severity:** P2
- **Classification:** Maintainability/testability improvement
- **Evidence:** private class fields prevent structural substitution; test uses
  `as unknown as JsonataEvaluator` for a one-method fake.
- **Impact:** mapping is coupled to worker implementation and composition cannot
  own lifecycle/telemetry cleanly.
- **Remediation:** depend on a minimal evaluator Interface and inject an
  application-owned singleton.
- **Verification:** type-safe fake with no cast and composition shutdown test.
- **Status:** Open.

### WM-007 — Worker startup has no deadline

- **Severity:** P2
- **Classification:** Reliability gap
- **Evidence:** 100 ms timer starts only after `started`; no timer covers Worker
  creation, JSONata import, ready message, or context handoff.
- **Impact:** a wedged startup consumes a slot indefinitely and can saturate all
  expression evaluation.
- **Remediation:** add a separate supervisor startup bound and typed failure;
  terminate the worker on expiry.
- **Verification:** worker fixture that never becomes ready and recovery test.
- **Status:** Open.

### WM-008 — Evaluator runtime is embedded untyped code

- **Severity:** P2
- **Classification:** Maintainability/control gap
- **Evidence:** worker implementation is a dense `String.raw` program invisible
  to normal TypeScript, lint, navigation, and file coverage.
- **Impact:** security-critical isolation logic is harder to review and can
  drift without static checks.
- **Remediation:** compile a private typed worker entry and run built-artifact
  integration tests.
- **Verification:** lint/typecheck includes runtime; package tests execute the
  emitted worker file.
- **Status:** Open.

### WM-009 — Failure-delivery schema admits impossible states

- **Severity:** P2
- **Classification:** Contract-modeling defect
- **Evidence:** one flat object accepts contradictory kind/dispatch/reference
  combinations.
- **Impact:** corrupted or future producer data can erase the safety distinction
  that controls retry versus manual reconciliation.
- **Remediation:** use a strict discriminated union with kind-specific literals
  and fields.
- **Verification:** exhaustive valid matrix and rejection of every contradictory
  combination through database persistence parsing.
- **Status:** Open.

### WM-010 — Public limits/canonical helpers and coverage need stronger boundaries

- **Severity:** P3
- **Classification:** Continuous-control and API-hardening gap
- **Evidence:** direct canonical recursion is unbounded; validation overrides
  are unparsed; package has no coverage gate.
- **Impact:** expert-only assumptions are exposed as general public APIs and
  high-risk branches can regress unnoticed.
- **Remediation:** document/validate preconditions, move test overrides behind a
  test seam, make canonical traversal iterative where public, and add risk
  coverage.
- **Verification:** deep direct input, invalid overrides, and CI threshold tests.
- **Status:** Open.

### WM-011 — Root facade and large files obscure ownership

- **Severity:** P3
- **Classification:** Maintainability improvement
- **Evidence:** `graph.ts` and `expressions.ts` combine distinct owners; root
  wildcard exports are unused by production consumers and automatically widen.
- **Impact:** changes have low Locality and public surface can grow accidentally.
- **Remediation:** split along the concrete internal seams above and use explicit
  facade exports without adding new public subpaths.
- **Verification:** package export snapshot, dependency-boundary test, and
  unchanged public type/behavior fixtures.
- **Status:** Open.

## What should remain unchanged

- Keep graph ownership in this package and database representation as one JSONB
  snapshot plus derived indexes.
- Keep browser-safe contracts separate from server execution utilities.
- Keep drafts structurally readable before semantic validity, while publishing
  fails closed.
- Keep exact definition versions, versioned policy references, retained
  verification, and no latest fallback.
- Keep canonical domain-separated identities and cross-process golden fixtures.
- Keep JSONata deliberately restricted and hard-terminate timed-out work.
- Keep explicit mapping variants and missing-versus-null semantics.
- Keep aggregate loop/expansion limits and global node identity across bodies.
- Do not deep-freeze every large graph without mutation/performance evidence.

## Recommended implementation order

1. Reject statically invalid mapping topology before publication (WM-001).
2. repair evaluator construction accounting and make the worker architecture
   and evidence truthful (WM-002).
3. align shared graph admission and cap validation responses (WM-003, WM-004).
4. close canonical array and notification state boundaries (WM-005, WM-009).
5. add startup supervision and move worker runtime into checked TypeScript
   (WM-007, WM-008).
6. introduce the evaluator port and composition-owned lifecycle (WM-006).
7. add risk coverage and perform the ownership split without public API churn
   (WM-010, WM-011).

After remediation, run package build, typecheck, lint, unit/coverage gates,
browser/server differential fixtures, API validation integration, executable
compilation/execution tests, real worker shutdown tests, and the full pre-push
gate. Close findings only with concrete evidence.
