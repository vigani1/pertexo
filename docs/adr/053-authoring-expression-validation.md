# ADR 053: Expression admission for new workflow publications

- **Status:** accepted — staged delivery; model implementation authorized first
- **Date:** 2026-09-28

## Context

[ADR 009](009-restricted-jsonata.md) requires publication-time restricted JSONata
validation. Current draft validation checks graph structure and mapping scope;
compilation checks policy pins, but malformed source reaches the runtime parser.
For example, `runInput.` is structurally accepted and rejected by the existing
restricted parser. This prevents a truthful expression finding in the editor.

The same structural validator also supports retained-version checksums. Tightening
it globally would change historical reads and replay, not merely new publication.
Completed publication receipts are reconciled before the current draft is read;
that ordering must remain intact after later draft edits.

## Decision

Use a named server-only authoring-validation module in `workflow-model`, composed
with the existing structural validator and restricted parser. Explicit draft
checks and admission of **new** publications call the same module. Retained
checksums, readers and historical execution keep their existing contracts.
Do not add a boolean validation mode to `validateWorkflowGraph`, silently tighten
`parseWorkflowGraphForPublish` at every caller, or introduce a browser evaluator.
The named interface makes the admission purpose explicit without teaching every
historical reader which safety flag to select.

The module validates mappings recursively, including structured bodies, against
the pinned evaluator policy. Policy support comes from the canonical selected
release; use a narrow policy projection if the existing definition projection
cannot supply it. Do not invent another catalog or independently maintained
policy allowlist. Unsupported policies remain readable drafts but fail admission.
Reuse the existing AST/profile rules, not substring checks or full evaluation.

Return bounded shared findings with a distinct expression issue code and the
actual mapping path, including nested `.structured.body` paths. Do not reuse
`invalid_mapping`'s current predecessor-only explanation for a syntax failure.
Sanitize messages, preserve the report's saved-revision/staleness metadata and
existing 100-issue cap. The frontend navigates through its current mapping-target
resolver and dirty-inspector guard; unresolved targets remain readable findings.

New publication runs admission on the locked original draft only after exact
receipt reconciliation and existing authorization/precondition checks. A completed
original command must still return its immutable result when a later draft has
invalid expressions. No new receipt, version, audit or execution may be produced
by that retry.

## Resource gate and decision basis

Keep ADR 009's per-expression source (16 KiB), AST depth (64) and AST node (2,048)
limits and the existing graph limits (1 MiB, 1,000 nodes, structured depth 32).
These are not sufficient evidence of acceptable aggregate parser cost: one node
can have many mappings, and the synchronous parser runs before runtime evaluation's
100ms deadline. An AbortSignal or report cap cannot interrupt that synchronous work.

The implementation proposal must therefore supply measured aggregate source,
distinct-expression and cumulative-AST work bounds before approval. Preflight
all aggregate source/count limits before parsing; memoize identical
`(policyVersion, source)` only within that one validation invocation. Bound queue
admission and isolate parsing if measurements cannot establish safe synchronous
work. Do not claim the existing evaluation deadline bounds preparse, add a second
unbounded pool, or silently deploy new graph restrictions. Any stricter aggregate
admission limits must be explicitly approved and documented here first. This
resource gate was subsequently resolved by the bounded off-thread operating
defaults below, without accepting stricter graph or expression-language limits.

## Delivery and compatibility gates

1. Approve aggregate resource bounds from adversarial and representative parsing
   measurements; compare minimal bounded reuse with isolation only if necessary.
2. Add the shared issue schema/type and generated artifacts, canonical server
   module, draft-check adapter and new-publication adapter; keep browser imports
   on their existing browser-safe subpaths.
3. Cover malformed source, disallowed constructs, unavailable pins, exact/over
   limits, aggregate exhaustion, nested paths and bounded sanitized reports.
4. Prove checks and publication agree; invalid drafts remain saveable. Preserve
   retained checksum/read/replay and completed original publication reconciliation
   after later invalid edits, including no duplicate audits or versions.
5. Exercise actual editor findings and mapping navigation with dirty scratch
   protection through the local authorized API; do not fabricate a report to
   substitute for backend admission. Run bundle/import checks and existing
   expression/authoring/compiler/publication regressions.

This decision introduces no new endpoint, persistent state, evaluator language,
runtime fallback or deployment change. Model implementation is staged first;
adapter integration and final compatibility evidence require subsequent review.

## Exact ownership and proposed interface

| Current owner / seam | Proposed responsibility | Compatibility requirement |
| --- | --- | --- |
| `node-catalog` selected registry release definitions | Canonical exact definition `policyReferences` | No independent policy allowlist or browser exposure |
| API `platform/workflow/workflow-compatibility.ts`, `projectDefinitionCatalogs` / `createCoreAuthoringOptions` | Derive a narrow immutable policy projection from the **same** `nodeRelease` as each variant; close its admission callback over that projection | Do not change the executable release fingerprint/catalog identity |
| Database `workflow-authoring-compatibility.ts`, `selectLocked` | Select existing durable release and matching admission callback | Latest API-memory release alone is insufficient during rollout |
| Database `workflow-authoring-reads.ts` / API `ValidateWorkflowDraftUseCase` | Focused `validateDraft` read operation obtains snapshot, selected variant and result together; use case retains authorization/serialization | Existing ordinary reads/save/restore remain lossless; no validation writes |
| Database `workflow-publication.ts`, `lockAndCompilePublication` | Same selected variant admission after original ETag check, before compilation/persistence | Completed `claimPublication` replay still returns before current-draft validation |
| Model `checksumRetainedGraph` / database `mapVersion` | No authoring admission | Historical V1 checksum/read remains unchanged |
| Engine executable readers/builders and run replay acceptance | Existing pinned executable/runtime guarantees | No new syntax re-admission of retained versions |

`PlatformNodeDefinitionBrowserProjection` intentionally excludes policies;
`WorkflowDefinitionCatalogV1` contains identities/integration metadata only.
The existing API projection drops `policyReferences`. Injecting latest policies
into the use case independently would not match the database-selected release.

Illustrative **proposed**, not accepted, interfaces:

```ts
// Named workflow-model server module; reuse existing graph/result types.
validateWorkflowAuthoringGraph(
  graph: WorkflowGraph,
  policies: WorkflowExpressionPolicyProjection,
  signal?: AbortSignal,
): Promise<GraphValidationResult>;

// Per-variant callback, closed over its immutable release-derived policy projection.
validateAuthoringGraph(graph: WorkflowGraph): Promise<GraphValidationResult>;

// Feature-owned persistence read; authorization/release selection remain inside it.
validateDraft(workspaceId, workflowId, actorId): Promise<{
  draft: WorkflowDraftRecord;
  validation: GraphValidationResult;
} | null>;
```

The projection contains release identity and exact definition/policy pairs from
existing manifests, not another schema registry. Production variants must not
silently omit admission. Approve operational overload/cancellation handling first:
an unavailable validator is not proof that a graph is invalid.

## Local bounded measurement evidence

2026-09-28, source HEAD `494fb9cc`: Node 24.15.0, JSONata 2.2.2, macOS arm64 /
Apple M4, 10 logical CPUs. The existing compiled public expressions facade was
called without evaluation. Each experimental child had an external 2,000ms kill
deadline, 64 MiB old-generation heap and 1,024 KiB stack. Eleven individual
fixtures each performed 20 typed-outcome assertions; four structurally admitted
aggregate fixtures each ran two parser-only rounds. No services were started.

Retained directory: `/tmp/pertexo-expression-admission.zRMvqa`. Scripts contain
the identical bodies originally executed with `node --input-type=module -e`:

| Artifact | SHA256 |
| --- | --- |
| `individual.mjs` | `935e89f74b003bed77872133385c6f629cc65160cc5e026114070b70a61813c0` |
| `aggregate.mjs` | `a353db154d37cb78b40c80c872d8a457d6e26d421b1d0c162d6a9656a046eef9` |
| `results.json` | `007253e132e8e9cfad43a6bc7384f4edbafa80a876306edab89ddfa8ab1bf2f3` |

`results.json` explicitly transcribes captured successful stdout; no measurement
was repeated when retaining these files. Reproduction commands: `node
/tmp/pertexo-expression-admission.zRMvqa/individual.mjs` and `node
/tmp/pertexo-expression-admission.zRMvqa/aggregate.mjs`. Both passed `node --check`.
These task-local artifacts are not production assets or another audit document.

Individual median / maximum parser milliseconds: representative 0.063 / 0.343;
exact 16 KiB source 0.160 / 0.483; exact 2,048-node AST 0.894 / 2.447;
near-source-limit flat AST rejection 2.201 / 5.009; deeply nested near-source-limit
malformed source 0.617 / 1.092. Exact/over byte, AST depth/node, malformed and
disallowed fixtures returned their asserted existing policy outcomes.

| Structurally admitted fixture | Graph bytes | Source bytes | Parser-only rounds (ms) | Outcome |
| --- | ---: | ---: | --- | --- |
| 1,000 nodes / 1,000 distinct simple mappings | 252,834 | 15,890 | 18.460; 15.377 | Valid |
| 200 nodes / 200 distinct exact-AST-limit mappings | 866,634 | 819,290 | 202.037; 106.907 | Valid |
| 60 nodes / 60 distinct near-source-limit flat expressions | 996,874 | 982,670 | 144.336; 133.179 | AST limit rejected |
| One node / 5,000 distinct simple mappings | 527,983 | 83,890 | 85.797; 72.601 | Valid |

Graph admission separately took 25.050, 12.607, 6.961 and 35.518ms respectively.
Parser times exclude admission, process startup and IPC. Parsing is synchronous
inside the isolated experiment; this does **not** make the current API parser
off-thread. Two batch rounds are not percentiles or a universal worst-case bound.

The valid 202ms batch prevents claiming graph/per-expression limits imply
negligible synchronous work. One node's 5,000 mappings also disproves deriving
mapping count from the 1,000-node cap. Compare:

- Minimal synchronous admission needs approved aggregate preflight budgets;
  smaller budgets change accepted graphs. Deduplication does not help distinct
  sources, and cancellation checks cannot interrupt parsing.
- Bounded off-thread batch parsing retains the public graph envelope but needs
  reviewed finite admission, parse/queue deadlines, memory and disposal ownership.
  `JsonataEvaluator.evaluate` is not an adapter: it first parses synchronously,
  then executes; its worker protocol has no validation-only command.

Selected direction: preserve the graph envelope and implement the smallest bounded
off-thread authoring parser, reusing actual worker-ownership patterns and policy
where appropriate. The operational defaults below were subsequently approved;
these local observations do not establish production-load safety or authorize
changing syntax/graph limits.

## Planned compatibility regressions

- Model expression/admission tests: exact/over current limits, pins, recursive
  paths, aggregate bounds, repeated-source reuse and bounded operational failure.
- `retained-workflow-v1.test.ts` and engine executable identity/input tests:
  retained checksum/read/replay of now-rejected new-authoring source is unchanged.
- API authoring use-case tests: validation/publication agreement, selected-release
  alignment, unavailable validation and unchanged authorization.
- Database publication/atomicity/coordination integrations: original completed
  receipt followed by invalid newer draft returns the original version; changed
  key/body fails; no duplicate audit/version; release/ETag races remain atomic.
- Existing web mapping tests plus a future real validation journey: truthful
  findings/counts, resolvable nested focus and dirty scratch guards; browser
  import/bundle checks exclude Node/parser modules.

These additions are planned, not executed acceptance tests. The model mechanism
is authorized by the staged decision below, not proven by measurement alone;
persistence/API/frontend integration still requires model review first.

## Approved operational policy

Lifecycle owner: one `WorkflowAuthoringValidator` owned by API workflow runtime,
with `validate(graph, selectedPolicies, { signal })` and memoized `shutdown()`.
Its focused workflow-model implementation owns batch admission, one-shot parser
workers and cleanup. No global state, public mode flag or general job framework.
Database variants receive a closure using that owner and their release projection;
the database never creates workers. Runtime construction-failure and shutdown
paths must drain this owner before releasing authoring resources, and retain
unconfirmed worker failures rather than reporting successful disposal.

Approved reversible **operational defaults**, not new syntax/graph limits:

| Resource / phase | Proposed default | Rationale / enforcement |
| --- | --- | --- |
| Active authoring parser batches per API process | `min(2, availableParallelism())` | Keep CPU admission small; one worker processes a whole batch, not one worker per mapping |
| Queued batches / queued serialized bytes | 4 / 4 MiB | Both limits checked before retention; reject immediately when either would be exceeded |
| Serialized batch envelope | 2 MiB | Existing 1 MiB graph plus bounded selected policy projection; oversized operational payload is unavailable, not an invalid graph |
| Queue residence | 500ms | Deadline from submission; no infinite wait while a transaction is open |
| Worker startup | 500ms | Deadline begins when the worker is created; covers readiness, not just successful startup |
| Parsing and report construction | 1,000ms | Starts **before** posting the batch, not upon a potentially absent `started` message; about five times the measured cold valid 202ms batch, not a universal guarantee |
| Termination observation after result/abort/failure | 250ms | Bound caller wait; retain occupied capacity/unconfirmed ownership if termination is not observed |
| Worker memory | 64 MiB old generation / 8 MiB young generation / 4 MiB stack | Old-generation ceiling matches the measurement setup; stack follows ADR009's existing worker pattern rather than turning the experiment's smaller stack into a syntax rule |
| Expression report | Existing 100 findings; 256 KiB serialized report; 512 UTF-8 bytes per safe message | Bound output and transient retention; report-budget exhaustion is operational failure, never a fabricated “valid” report |

These are approved starting defaults, not measured production guarantees. The
existing evaluation pool remains separately bounded at its ADR009 limits; with
four evaluator slots, two additional parser slots yield at most six such workers
per API process, not an unlimited second pool. Account for combined memory/CPU
and configured API process count in the implementation verification. Do not
change runtime-evaluation policy or silently multiply limits per publication
variant. The validator instance and capacity are shared by all variants/callers.

Prefer the smallest separate, bounded **authoring-only** owner, reusing the
existing policy functions and worker-lifecycle invariants: explicit ready/start /
result protocol, memoized termination, retained slots until confirmed exit,
shutdown abort and late-result fencing. Making `JsonataEvaluator` a generic
scheduler would broaden its public interface and alter runtime behavior; calling
its `evaluate` would execute expressions. Neither is justified. Extract a private
termination helper only if both actual owners need identical behavior; do not
preemptively introduce a shared supervisor framework.

The worker receives an already admitted graph snapshot and the selected policy
projection, not database/HTTP clients or credentials. It walks structured bodies,
uses the current restricted parser without evaluation, and deduplicates only
within that invocation by `(policyVersion, source)`, caching a small policy result,
never ASTs. Graph/envelope byte admission bounds source and mapping retention;
the node limit is not used as a mapping limit. No cross-request cache or reuse of
reports across draft revisions/releases. Build paths/messages incrementally
within the output budgets; do not allocate a huge intermediate report first.
Continue checking enough input to establish correctness or return operational
unavailability when the approved work budget expires; hitting 100 findings must
never turn a partially checked graph into a successful admission.

Overload, queue/start/parse expiry, failed termination or result-budget exhaustion
must be a distinct typed operational error. Proposed HTTP mapping:
`workflow.validation_unavailable`, 503 with bounded `Retry-After: 1`, fixed safe
detail and no “invalid graph” findings. This requires shared problem/OpenAPI and
frontend recovery review before implementation. Syntax/policy failures still use
truthful mapping findings; a timed-out valid graph is not reclassified as invalid.
Explicit publication recovery retains its exact original key/body/ETag. No
automatic replay or current-draft substitution is introduced.

Request cancellation must propagate through use case/persistence into this owner
and the existing tenant transaction's supported `AbortSignal`. Remove queued
jobs/byte reservations immediately. Abort active workers, ignore late results and
retain their slots until confirmed termination; on failed/bounded termination,
fail the caller and quarantine that slot rather than blocking rollback forever
or accepting another worker under its capacity. Shutdown aborts queued/active
work and surfaces unconfirmed cleanup. Bind HTTP abort to actual premature
request/response disposal, not every normal request `close` event. Cancellation
after a committed publication cannot undo it; ordinary exact receipt recovery
remains necessary for a lost acknowledgment.

### Transactions and maximum added lock wait

Current `withAuthorTransaction` delegates to `withTenantScopedClient`, which
begins a transaction, awaits its operation and commits/rolls back. Current API
pool defaults are 5s lock timeout, 30s statement timeout and 35s idle-transaction /
query timeout (`packages/database/src/platform/postgres-pool-policy.ts`). SQL statement timeout does
not bound a JavaScript parser queue between statements. The proposed 500ms queue
deadline is explicit; no reliance on those database timeouts to supervise workers.

- **Draft check:** the proposed focused read retains the same snapshot/release
  selection transaction while awaiting bounded admission. No new draft `FOR
  UPDATE` is proposed, but the checked-out connection and existing compatibility
  selection locks remain held. Returning a separate latest-policy report later
  would lose release alignment.
- **New publication:** existing order stays authorization → original receipt
  claim/replay → compatibility release selection → workflow/draft row locks →
  original ETag check → bounded admission → compile/persist/audit/commit. Parser
  queue and execution therefore occur under those existing locks; the transaction
  is not split and no new lock order is introduced.
- **Completed exact retry:** returns its receipt before admission and does not
  need an available parser slot or validate a newer draft.

Maximum **added parser-phase application wait** before requesting rollback is
500ms queue + 500ms startup + 1,000ms parse + 250ms termination observation =
2,250ms, subject to host scheduling. Admission failures never wait indefinitely
for worker termination: an unconfirmed pure worker owns no database client, so
rollback is safe while its capacity remains quarantined. This is not a claim
that the entire transaction or network rollback finishes within 2,250ms; existing
SQL/acquisition/rollback deadlines still apply. Custom smaller database idle /
query budgets must be checked against these operational defaults before enablement,
not disabled or silently raised. Verify injected stuck startup/parse/termination
and queue saturation release locks/clients through the existing transaction seam.

Avoiding all waits under locks would require an additional snapshot/admission
phase and rechecking release/ETag/receipt afterward. That larger transaction
restructure is not recommended for this slice; revisit only if real contention
evidence shows the small finite additional wait is unacceptable.

Later review gates: implemented lifecycle interface, selected release/persistence
seam and the under-lock bound. Implementation must prove
queue-byte/accounting, timeout/abort/shutdown, no late result, failed termination
quarantine, lock release and exact historical receipt/read/replay regressions.
The accepted ADR records policy, not successful implementation evidence.

### Acceptance and staged authorization (2026-09-28)

Independent review accepted the selected off-thread direction, finite defaults
above and operational 503 recovery as reversible operating policy, not new
syntax/graph limits. Earlier proposed sketches/measurements record the decision's
basis; they are not proof that the implementation already exists.

`withTenantScopedClient` supports cancellation, but **`withAuthorTransaction`
currently does not forward `options.signal`**. Explicit threading through HTTP,
use case, persistence and that wrapper is required in the later integration;
do not describe current cancellation as end-to-end. Failed exit retains its
occupied parser slot even after caller failure. The 2,250ms application budget
is scheduling-qualified, not an entire database deadline. Custom smaller idle
budgets must fail closed; do not raise existing database configurations silently.

Only stage 1 is authorized now: the focused workflow-model validator/worker owner,
its tests/build and server-only export boundary. Verify real parsing/pins/nested
paths, queue count/bytes, abort/start/parse/termination quarantine and late results,
shutdown, report caps, no AST/credential leakage and unchanged graph admission.
Stage 2 (shared API problem/artifacts and API/database adapters/cancellation)
requires independent review of stage 1. Stage 3 (frontend findings/recovery and
real receipt/retained/security/live qualification) follows separately. No API,
database or frontend admission changes, new live gates or push are authorized
by the stage-1 decision. F01 remains incomplete until those later gates pass.

### Stage-1 model implementation evidence (2026-09-28)

The server-only `@pertexo/workflow-model/authoring-validation` interface now owns
`WorkflowAuthoringValidator.validate(graph, selectedPolicyProjection, { signal })`,
`shutdown()` and count-only `diagnostics()`. It does not evaluate expressions or
export parser internals/ASTs. Policy projection is a strict, duplicate-free
definition/policy snapshot; later adapters must derive it from the same selected
release. This implementation does not establish that API/database callers already
supply that snapshot or forward cancellation.

One owner bounds queue count/bytes and compiled Node worker startup, parse and
termination. Queue deadlines start at submission and are rechecked before
dispatch, even if the timeout callback is delayed. A slot is released only after
an observed worker exit; bounded termination failure rejects the caller and
retains that slot. Shutdown is memoized, closes admission, removes queued payloads
and reports unconfirmed exits. Reports are bounded and sanitize parser failures;
unsupported policy pins remain distinct from malformed source. The new export
has an explicit `browser: false` condition as well as the legacy browser map.

Verification: `pnpm --filter @pertexo/workflow-model test` builds first and passes
**13 files / 160 tests**. The suite includes real compiled-worker parse-only
checks and existing retained-version/structural/expression regressions; injected
workers/fake clocks test queue, failure and lifecycle transitions. Model typecheck
and focused ESLint pass (repository-established 8 GiB lint heap). The initial
default-heap lint attempt exhausted 4 GiB; no rule was suppressed. Focused built
consumer probes verify declarations/exports and browser-condition rejection;
source import checks pass 13 tests and the repository scan. Model-only complexity
inventory reports no file/function hotspots. No new live services or adapter,
database, HTTP, frontend or production-load qualification ran for this stage.

The focused Knip workspace check initially identified the compiled worker's
dynamic URL entry as unused. It is now declared alongside the existing expression
worker entry in the root Knip configuration; the focused check passes. This
registers the actual worker entrypoint rather than ignoring a diagnostic/rule.

Independent review then identified two lifecycle/budget defects and withheld
adapter approval. Before correction, focused tests reproduced successful results
after abort/shutdown during termination (**2 failures**, 8ms) and oversized
structural report accumulation (**1 failure**, 9ms, bounded ~0.8 MiB fixture).
Termination remains memoized and late worker messages fenced, but cancellation
and shutdown can supersede a provisional result until caller settlement. Abort
listeners remain until settlement; closure is rechecked after observed exit.
An already settled outcome is not rewritten.

Structural byte/message admission now runs **before insertion** at the canonical
collector via an internal callback seam. Its refusal propagates as operational
`report_limit`, not a caught `invalid_graph`; unrelated canonical-data failures
remain structural. Historical public signature, count-only collection and full
identifiers are unchanged. A real compiled-worker regression uses an admitted
500 KiB ID and 100 invalid mappings; the bounded accumulation regression and
historical-output test distinguish authoring protection from legacy behavior.
Final focused owner/package tests pass **2 files / 46 tests**; typecheck/lint,
Knip and model complexity checks remain green. Adapter-plan review is required
before integration; these corrections are not live HTTP/transaction
or frontend evidence.

Independent re-review approved stage 1: both review axes report no remaining
findings, and the independent focused run passes **46/46**, 858ms. This clears
the model interface/lifecycle gate, not adapter implementation or a push.
Shared wire issue schemas,
503 artifacts, release-aligned adapters, cancellation propagation and real
transaction/publication/editor qualification remain unimplemented in this stage.
