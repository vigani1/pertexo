# Backend code-quality plan: a defensible 9/10

Date: 2026-09-10. Status: planned; not implemented by writing this document.

## Purpose, scope and authority

This is the implementation handoff for improving **local code quality** across
all six assessed sections. Production readiness is a separate assessment.
Deployment, AWS access, live provider delivery, production traffic and regional
drills are **not prerequisites for a 9/10 or 10/10 code-quality assessment**.
They remain separately gated by E01/Q14 and do not belong in this backlog.

**Repository-wide application is mandatory.** For each improvement in this
plan, find and account for every relevant occurrence across the repository,
implement it everywhere it applies, and verify all affected consumers. Named
files and scenarios below are starting examples and minimum requirements, not
the boundary of the work. Completing the examples alone is not completion.

The user requested a detailed plan, not implementation in this turn. A later
instruction to implement this plan authorizes its local code, test and
documentation work, but not commits, pushes, deployment, paid resources or live
external side effects. Preserve the existing dirty checkout and unrelated work.

Read `AGENTS.md`, `CONTEXT.md`, the backend blueprint and relevant accepted ADRs.
The [completed next-stage record](backend-quality-next-stage-plan.md) and
[earlier Q01–Q14 record](backend-quality-improvement-plan.md) describe existing
work. Preserve their fixes rather than repeat them. Update blueprint progress
only if its actual claims change; record this roadmap's execution here.

Keep PostgreSQL execution authority, tenant/RLS isolation, transport-only
BullMQ, pinned compatibility identities, the NestJS/TypeScript build and the
existing provider choices. Ordinary private refactoring needs no ADR. A real
architectural decision needs its ADR before implementation, not an incidental
change hidden in a refactor.

### What is already done

Do not recreate shared authenticated request types, worker activation ownership,
managed-command extraction, provider retry/uncertainty fixes, reclaim migration
0086, lost-COMMIT proof, the 22 branch dispositions, the seven mutation canaries,
or schema-v4 target-database sampling. The latest recheck found those substantive
changes implemented. The remaining benchmark gap is **automatic validation of
newly generated evidence**, not another repair of the already-correct sampler.

Reference evidence is the stable local qualification
`2026-09-10t10-48-49-281z-78496-16f7e49b`: 21 passing cohorts, 2,463
unit/component tests, 519 passing service assertions and three explicit AWS-only
skips. The subsequent focused recheck passed 58 infrastructure tests and real
artifact self/cross comparisons. These are source-bound observations, not a
guarantee about a later checkout. Planning does not require repeating them.

## Fixed assessment rubric

The earlier overall 8/10 mixed code quality with operational uncertainty. For
this plan, score the six rows below using code and local evidence only. Scores
are engineering judgments, not percentages calculated from test counts.

| Section | Starting assessment | Evidence required to justify 9/10 locally | Optional 10/10 stretch |
| --- | --- | --- | --- |
| Naming and organization | Approximately 8/10 | Current behavior-to-owner navigation; unambiguous names in changed flows; one authoritative status route; no unnecessary file/alias churn | A second reviewer can locate policy, persistence, ownership and tests for the selected change scenarios without corrective guidance |
| Control flow and readability | Approximately 8/10 | All applicable flows found by the improvement-family inventory expose their phases and invariant families; ordering stays explicit; no helper merely moves a large argument list elsewhere | Change exercises show that a rule can be changed in its owner without reconstructing unrelated phases or changing unrelated tests |
| Responsibilities and interfaces | Approximately 8/10 | Callers depend on the capabilities they use; shared facts have one owner; runtime and transport concerns stay outside domain inputs | Selected interfaces remain simple under the concrete variation exercises, with no parallel legacy path or speculative extension mechanism |
| Runtime, data and error safety | Approximately 8/10 | No unresolved confirmed local safety defects in scope; changed interfaces have explicit error, cancellation, lifetime and identity contracts protected through their real consumers | Deterministic combined-fault and bounded-input cases protect the selected invariants, with independent expectations and no known unexplained mismatch |
| Tests and verification | Approximately 9/10 already | Preserve meaningful coverage and sensitivity; new work is discovered by normal gates; evidence generation and consumption agree; focused verification is reproducible | Selected tests survive implementation replacement and catch a deliberately broken invariant; reports are linked to actual executed results automatically |
| Local performance and resource discipline | Approximately 8/10 | Validated evidence plus measured work/space growth for applicable hot-path families; bounded inputs and I/O; no demonstrated avoidable regression | Representative allowed limits remain predictable across repeated local measurements, with structural work-count assertions where possible and no unbounded ownership/cache behavior |

Completing a checklist does not automatically award a score. At closeout,
explain how each row meets or fails these fixed criteria. Do not introduce a
new deployment requirement or a new polish backlog to withhold a code score.
Large but cohesive modules are not automatically below 9/10. A retained design
can meet the rubric if its interface, phase ordering and change-locality are
demonstrably good.

The 10/10 column is a separate stretch assessment, not permission to expand this
plan indefinitely. Do not promise perfection or the absence of undiscovered bugs.

## Execution rules and finite work list

The improvement families are finite; their occurrence lists must be discovered
repository-wide. Finding another instance of an identified problem is required
rollout work, **not scope creep**. Unrelated improvements remain outside scope.

Every item needs a disposition and evidence. **Required** means its deliverable
must exist. **Conditional refactor** means characterization and comparison are
required, but production changes are justified only by demonstrated benefit.
An unsupported “retain unchanged” is not a completed design comparison.

For each conditional refactor compare the current design with one concrete
alternative. Record: caller facts before/after; ownership of each invariant;
files touched by a representative change; public surface added/removed; test
impact; query/allocation impact; and the chosen disposition. Prefer private
implementation changes to new public exports or frameworks. Retain the current
design if the alternative merely relocates complexity.

Never lower test/coverage/complexity gates, replace independent golden fixtures
with current serializer output, widen immutable contracts, or count reviewed
branches as executed branches. Do not add a generic repository, lifecycle
framework, parser generator, global utility layer or new test framework just
for this plan.

### Mandatory discovery, rollout and closure protocol

This protocol applies to every Q9 item and takes precedence over wording such
as “selected,” “target,” “changed interface” or “retained area” elsewhere in this
document. Those words do not exempt an equivalent occurrence from review or
implementation. The area table at the end is a routing aid, not an exclusion list.

1. **Enumerate the owned source.** Inventory all applications and packages,
   infrastructure/tooling, root build/test scripts, CI configuration and relevant
   documentation. Include tracked and non-ignored untracked code, alternate
   entrypoints, production/preview paths, compatibility readers, feature-flagged
   paths and test-support implementations. Record excluded generated outputs,
   vendored dependencies, caches and runtime artifacts. Inspect their source
   generators where relevant; do not hand-edit generated copies or read secrets.
2. **Search by improvement, not just filename.** For each family in the table
   below, use `rg`/file inventory plus import, export, reference and caller tracing.
   Search synonyms and structurally similar implementations, including functions
   with different names. A text search returning no exact-name duplicates is not
   proof that no equivalent behavior exists. Inspect the matches and their
   consumers to decide applicability.
3. **Record every candidate occurrence before calling the family complete.**
   Identify the file/symbol, policy or invariant, resource owner if relevant,
   callers, existing test, and whether the improvement applies. Record scanned
   areas with no matches and the search/review evidence. Do not use one blanket
   “other packages look fine” row.
4. **Distinguish shared semantics from similar syntax.** Compare error modes,
   ordering, cancellation, authorization, compatibility versions, lifetime and
   performance contracts. Group equivalent occurrences under one decision.
   Intentional differences require an explicit reason and owning tests; they are
   not permission to leave the same defect or duplication elsewhere.
5. **Roll out the improvement to all applicable occurrences.** A successful
   prototype in one module is only the start. Migrate every affected consumer,
   sibling path, internal alias, test adapter and relevant generator. Remove
   superseded duplicate algorithms after migration. Where a shared-owner change
   already fixes a caller, record that inherited fix and verify the caller; do
   not manufacture a meaningless edit merely to mark its file changed.
6. **Verify each occurrence and its interactions.** Map each applicable instance
   to a named assertion and executed result. Shared parameterized tests may cover
   several instances only when each is actually exercised and identifiable.
   Test both ordinary and relevant failure paths and the composed seam where
   persistence, external work or transport behavior matters. A shared-helper unit
   test alone does not prove every consumer was migrated correctly.
7. **Rescan after rollout.** Repeat the discovery queries and inspect remaining
   semantic variants, references, exports and callers on the final candidate.
   Classify new matches; confirm that no stale parallel implementation or
   unmigrated consumer remains. Record the scan's source identity and unresolved
   occurrences. An empty old-symbol search alone is not sufficient evidence.
8. **Close by reconciliation, not by example count.** Every discovered occurrence
   must be improved, already compliant, intentionally retained, or demonstrated
   not applicable. Pending, in-progress, blocked or unclassified applicable
   occurrences keep the item and affected section incomplete. Do not score an
   area as fully rolled out while only its named example files are finished.

Completed Q/N fixes and accepted designs are evidence to reuse, not an exemption
from this applicability scan. Keep sound implementations unchanged and preserve
their established authority. If a current occurrence violates the same invariant
being improved, address it even if a previous broad review retained its module.
If retention is still justified, cite the exact decision and current evidence;
do not silently reopen architecture or force a uniform implementation.

### What to search and apply throughout each area

| Improvement family | Repository-wide discovery obligation | Rollout / verification obligation |
| --- | --- | --- |
| Q9-01: names, status and ownership navigation | Find every active status entrypoint/link and every occurrence of the affected contract/concept names, including exports, aliases, callers, tests and generated-source templates | Correct every stale active route and misleading applicable name; preserve historical records and stable wire/database names; verify all references, not only the codebase map |
| Q9-02: ordered I/O versus pure proof/projection | Find loaders and assembly paths mixing persistence reads with substantial validation, reconciliation or projection across database capabilities and their application consumers | Evaluate each against the same locality criterion; apply justified separation everywhere it helps, preserving each path's actual read/validation order, transaction, batching and failure contract |
| Q9-03: reviewable invariant families | Find dense relationship validators and repeated identity/index/scope checks in persistence codecs, engine checkpoints, executable/graph validation and registration/release code | Give each applicable family an explicit owner and behavioral characterization; preserve version-specific semantics and deliberate separate authorities rather than merge validators indiscriminately |
| Q9-04A: neutral shared contracts | Find shared types/capability contracts defined inside a concrete handler or implementation and imported by siblings, including API, worker and package implementations | Move genuinely shared contracts to the appropriate neutral local owner, migrate all consumers and preserve required aliases/exports; no remaining sibling should depend on a concrete implementation solely for that shared contract |
| Q9-04B/Q9-05: duplicated verification, context and traversal knowledge | Find equivalent executable-verification algorithms, actor/context assembly, nested traversal and derived identity/report logic across all consumers, not only the initially named worker engines or controllers | Consolidate each genuinely equivalent family at its correct owner and migrate every caller; explicitly retain admission-versus-execution, feature error, transport and compatibility differences |
| Q9-06A: value-boundary contracts | Find every relevant parse, normalize, serialize, persist and reload interface for the affected JSON/value contracts, including browser/server paths and test adapters | Account for all producer-to-consumer transitions; verify preserved values, bounds and intended rejection/conversion differences without widening immutable contracts |
| Q9-06B: errors, cancellation and resource lifetime | Find owners of pools/clients, child processes, workers, streams, subscriptions, timers, locks and external-call contexts across applications, packages, infrastructure and test support | Apply the identified ownership/error rules to every applicable owner: failed startup, cancellation, stale authority, drain/close ordering, primary-plus-cleanup failure and no escaped resources; verify each consumer path and retain policy differences |
| Q9-07/Q9-09: evidence producer/consumer agreement | Find local report/artifact generators, readers and gates for coverage, integration, mutation, performance and other qualification evidence, including standalone and CI entrypoints | Ensure applicable producers emit what consumers validate and success gates validate actual emitted evidence with correct source/run identity; no sibling entrypoint may bypass the relevant check |
| Q9-08: interface-level tests and focused verification | Inventory tests, fixtures, scripts and CI discovery for every occurrence changed or retained under these families | Give every occurrence an owning proof and correct focused command; migrate obsolete tests safely, preserve independent historical/composed evidence and ensure new cases are discovered normally |
| Q9-10: bounded work and attributable measurement | Find analogous per-item I/O, repeated scans/serialization, pagination, collection expansion, buffering and resource-allocation patterns in all applicable hot paths | Establish each distinct family's bounds and valid populations, measure plausible bottlenecks, preserve batching/streaming and optimize demonstrated waste; the three initial probes are a minimum, not a cap |

The same occurrence may belong to several families. Give it one stable record
with cross-references rather than duplicate edits or tests. Every application,
package and infrastructure area needs a per-family scan disposition; this is
coverage of the **identified improvements**, not an unrelated audit of everything.

### Order, priority and ownership

| Wave | Items | Exit condition |
| --- | --- | --- |
| Establish scope | Q9-00 | Recoverable candidate identity, repository-wide family inventory, reused evidence assessed, focused test map |
| Concrete improvements | Q9-01, Q9-04, Q9-09 | Navigation corrected; shared worker knowledge has one owner; real benchmark output is validated |
| Focused design work | Q9-02, Q9-03, Q9-05 | Each alternative is characterized, compared and implemented or explicitly retained |
| Prove and streamline | Q9-06, Q9-07, Q9-08, Q9-10 | Boundary contracts, run-linked evidence, focused recipes and bounded-work results |
| Close once | Q9-11 | Reconciled occurrence inventories, final rescan, stable full qualification and the six evidence-backed code-quality assessments |

Prepare characterization before changing an interface. Q9-06/Q9-08 apply during
the preceding changes, not only after them. Q9-10 establishes comparable evidence
before optimizing a hot path. Q9-04's two worker changes are independently
reviewable, but their shared consumers need one integrating owner.

Independent read-only planning or non-overlapping edits may run in parallel.
Do not have Q9-07 and Q9-09 concurrently edit the local runner, or have multiple
owners rewrite the same checkpoint/input tests. Serialize coverage writers and
service qualification. Final integration belongs to one owner.

If commits are separately authorized, use coherent behavioral/refactor boundaries
with their tests, not a prescribed number of commits. Do not commit a broken
intermediate extraction. Without that authorization, keep a clear per-item
change inventory in this ledger and do not create repository commits.

### Q9-00 — Freeze the candidate and the verification scope

Required. Before implementation:

1. Record branch/upstream, HEAD, tracked and non-ignored untracked changes, and
   a content identity that includes the dirty candidate. Preserve a recoverable
   baseline patch/archive using the established N00 approach; do not commit it
   or capture secrets/generated runtime data.
2. Inventory every repository area for each improvement family using the protocol
   above, starting from the named examples. Refresh the complexity scanner and
   existing test map; historical line counts are context, not facts about a new
   candidate. Record matching occurrences and evidence-backed no-match areas.
3. Reuse the latest full evidence only after identifying intervening changes.
   An identical HEAD is insufficient. If differences are report-only, targeted
   documentation checks suffice. If code changed, run the affected checks;
   establish a fresh full baseline only when the retained evidence cannot
   establish a trustworthy starting point.
4. Freeze this rubric and the improvement-family list, not the example file list.
   Add every newly discovered applicable occurrence to its family during rollout.
   A discovered defect needs a reproduction and its connection to this scope.
   Record unrelated follow-up ideas separately instead of silently extending
   the work.

Done when: pre-existing user work is distinguishable from this implementation,
the starting evidence's limits are explicit, and each family has its occurrence
inventory and owning test commands. This is not permission to run the full
matrix after every edit.

## Part 1 — Naming and organization

### Q9-01 — Finish navigation and name the affected concepts consistently

Required, with narrowly scoped naming edits only when justified.

Targets: `docs/codebase-map.md`, `docs/current-implementation-status.md`, the two
existing quality records, this plan, and names introduced or changed by Q9-02
through Q9-06.

Observed remainder: the codebase map still directs readers to the predecessor
Q-plan for the latest exact candidate, while current implementation status points
to the next-stage record. The broader behavior ownership map and shared request
terminology already exist.

Required work:

- Link the latest implemented candidate to the next-stage implementation record;
  label the earlier Q record as earlier remediation history. Link this document
  as planned code-quality work, not as completed implementation evidence.
- Maintain the existing journey map for run/replay, webhook, schedule, provider
  execution, SSE, notification, artifacts and lifecycle/recovery. Update only
  rows affected by this work; each must resolve to policy, persistence, resource
  owner and an owning behavioral test.
- For the selected refactors, use names that express the actual job: loading
  persisted rows, validating a checkpoint relation, selecting a durable phase,
  or projecting already-validated inputs. Do not call all of them `process`,
  `handle`, `manager` or `utils` when the distinction matters.
- Preserve `Request` for transport shapes, `Input`/`Command` for application
  arguments, and explicit ownership for runtime outputs. Preserve exported
  aliases and wire/database names unless a real compatibility change is
  separately approved. Do not rename every `types.ts` or `use-cases.ts` file.
- Add a short change-navigation row for each implemented refactor: “to change
  this rule, edit this owner and run this test.” Reuse existing documentation
  rather than create competing architecture descriptions.

Verification: `pnpm docs:check`, `pnpm architecture:check`, affected typechecks,
and `git diff --check`. Name changes must have no orphaned imports or stale links.

Done when: the latest status route is unambiguous and a reviewer can locate each
changed rule and its test without being sent through superseded plans. File
renaming or documentation volume is not a success metric.

## Part 2 — Control flow and readability

### Q9-02 — Separate input proof/projection from ordered database reads

Conditional refactor; characterization and design comparison required.

Targets: `packages/database/src/execution/node-attempt-run-store-inputs.ts`
(`loadNodeAttemptInputs`), its contract/transaction/value-codec dependencies,
and the existing node-attempt/For Each integration suites.

Observed friction: the current 264-line / 43-branch read-client callback mixes
lease validation, four conditional SQL reads, stored-value decoding, upstream
reconciliation, join projection and structured-loop proof. The external interface
is already small; the improvement is private implementation readability, not a
new public database abstraction.

Proposed shape:

- Keep one named async orchestration path under the existing
  `withWorkspaceReadClient`. It retains all SQL, workspace predicates, snapshot
  ownership and cancellation handling.
- Give substantial pure rule families names: upstream-output reconciliation,
  join-input projection, structured-scope selection and collection-proof
  validation. They accept narrow row/checkpoint/input values, not a pool, client,
  callback bag or mutable catch-all context.
- Keep private helpers in the same file initially. Move a cohesive family into
  one private leaf only if that reduces navigation/review burden. Add no public
  database export or mock repository hierarchy.

Preserve the actual sequence, including validation between reads:

1. Validate input and permitted upstream invocation scope before checkout.
2. Read the current run/attempt/checkpoint with workspace, workflow version,
   current attempt, owner, fence, status and expiry constraints; decode run input.
3. Only for `wait_resume`, read and decode its output.
4. Only when requested, batch-read upstream outputs and reconcile them.
5. Parse the checkpoint, project join input and resolve the exact active loop
   scope before choosing a declaration to read.
6. Only for structured iteration, read the selected declaration and validate
   its identity, output agreement, count, ordinal and checksum.
7. Assemble the immutable result and existing abort/deadline information.

Do **not** fetch all four result sets first and validate later: that changes
fail-fast/query behavior and may select a loop declaration before its proof is
known. Do not add a query per upstream item, a second checkout, or a separate
transaction for a helper. Preserve `NodeAttemptStateCorruptError` and existing
abort/deadline projection rather than inventing a new completion policy here.

Required acceptance matrix (reuse existing cases where exact assertions exist):

| Case | Observable invariant |
| --- | --- |
| Invalid input/scope before checkout | Rejected before any database or provider work |
| Wrong workspace, owner, fence, current attempt or expired lease | No stale input bundle is returned |
| Inline run input and wait-resume output | Same values/metadata as before; artifact/malformed references fail as before |
| Multiple upstream outputs in differing row order | Same requested ordering/identity; one batched lookup, not N queries |
| Missing/extra/wrong-node upstream rows or node/attempt value disagreement | Corruption is rejected before later dependent work |
| Nearest-branch fallback | Only the already-permitted parent/current branch identities are accepted |
| Join ledger and selected branches | Same coordinator input; unselected/absent data does not become fabricated output |
| Nested iteration scope | Exactly one matching active loop; correct branch prefix and enclosing iteration path |
| Drifted declaration, collection checksum/size or ordinal | No structured collection is returned |
| Cancellation/deadline and acquisition cancellation | Existing durable flags/reasons and late-client cleanup remain unchanged |

Test owners: `packages/database/test/coordinator-run-store-node-attempts.integration.test.ts`
(including wait-resume), `coordinator-run-store-foreach.integration.test.ts`
(`loads only exact ordinal-scoped body inputs and fails closed on loop proof drift`),
stored-execution-value tests and the composed worker attempt suite. Pure cases
may support those tests but cannot substitute for them.

Done when: the SQL/validation order is visible in one orchestration path, a
collection/upstream rule change is local to its named family, and the public
consumer tests prove unchanged results/errors/query demand. No complexity
allowance may rise. If the proposed shape requires reviewers to reconstruct
more context across helpers, retain the current shape with the comparison and
its completed characterization.

### Q9-03 — Make checkpoint invariant families reviewable

Two required characterization work packages; production decomposition conditional.

**A. Persisted checkpoint validation.** Target
`packages/database/src/compatibility/persisted-workflow-checkpoint.ts`.
Its V2 `superRefine` callback currently combines 142 lines / 44 branches of
invocation indexes, branch selections, join scope, loop ownership/budget and
wait-state validation.

Compare the current callback with private named refinements for branch
selections, scopes/joins, and loops/budget. Keep the schema declarations,
normalization and public parse/serialize entrypoints together. Invoke the
families in the same order and retain the same issue/error behavior. No generic
schema framework, new wire version or shared database/engine parser is needed.

Required parser-interface cases:

- V1 and V2 canonical round trips, including the exact historical defaults and
  canonical ordering; unsupported versions still reject.
- Duplicate-identical versus conflicting branch selections; selection ownership
  and invocation status; ready/admitted index consistency.
- Correct and incorrect join identity/scope, loop control/barrier ownership,
  active/terminal ordinals and remaining-budget equation.
- `parseInitialWorkflowCheckpoint` valid initialization and each invalid
  identity, run status, revision/event cursor or initial-state condition.
- A payload violating two families, to establish preserved validation order
  where callers/tests rely on it. Do not impose new public diagnostic fields.

Reuse `packages/database/test/persisted-workflow-checkpoint.test.ts`,
`packages/workflow-engine/test/checkpoint-seam.test.ts`,
`checkpoint-risk-branches.test.ts` and the existing historical compatibility
fixtures. Add missing database parser cases through its parser, not by exposing
Zod refinement callbacks for testing.

**B. Checkpoint-to-executable matching.** Target
`packages/workflow-engine/src/operations.ts#assertCheckpointMatchesExecutable`
(currently 168 lines / 42 branches), called by `advanceWorkflow`.

Retain the one authoritative matcher initially. Build a compact invariant table
at the `advanceWorkflow` interface for: Merge/Parallel pairing and ledger ports;
canonical join key versus the permitted retained legacy key; invocation node,
branch and iteration identity; admitted-key membership; For Each control/body
topology, roots/sink, scope and pinned iteration/concurrency limits.

Start with valid hand-authored/historical checkpoints and mutate **one invariant
at a time**. Require the existing error class/code/phase and no returned transition
plan for invalid combinations. Include two-invalid-field controls for meaningful
failure precedence. Reuse `operation-risk-branches.test.ts`,
`executable-workflow-foreach.test.ts`, `checkpoint-seam.test.ts` and the existing
branching/transition cases. A small deterministic case generator is acceptable;
an unbounded fuzz campaign or new property-test framework is not required.

Do not force the database checkpoint codec and engine matcher to accept exactly
the same language: the engine knows executable topology and retained forms that
the storage codec does not. Record their responsibilities and intentional
differences. Share no compatibility interpretation merely because code looks
similar. Preserve independent V1/V2 fixtures, checksums, retry-policy identities
and historical normalization.

Done when: every listed invariant family has a named owning test, a reviewer can
identify its owner and ordering, and any extraction demonstrably improves that
task. Keep the matcher whole if splitting it would hide the authority sequence.
Existing passing cases satisfy requirements; do not duplicate them mechanically.

### Explicit non-task: do not split purge merely because it is large

`packages/database/src/lifecycle/workspace-purge.ts#processNext` is currently
525 lines / 45 branches. The Q08 review already established that its two public
methods hide three restartable durable paths with unusually strong real-service
proof. That accepted decision remains valid.

Keep discovery, short control-anchor transactions, exact ledger reconciliation,
workspace advisory-lock ownership, fenced claim/prepare, external I/O outside a
transaction, fence revalidation/checkpoint, and release/completion in their
explicit order. Keep the existing cancellation, stale lease, partial deletion,
ambiguous append, legal-hold and transaction-lifetime tests.

There is no mandatory purge rewrite or new duplicate test suite in this plan.
Still include its applicable I/O, validation, lifetime and error paths in the
family inventory. Reuse the existing proof when current; record justified
retention rather than exempting the module from the scan. Revisit its structure
only if the family review demonstrates a concrete locality problem. Then compare
three private durable-path functions against the existing owner; do not introduce
a configurable stage runner. Retaining an appropriately deep module does not
disqualify the control-flow section from 9/10.

## Part 3 — Responsibilities and interfaces

### Q9-04 — Give shared worker contracts and projection verification one owner

Required focused structural work. These are observed ownership/duplication
problems, not claims that current execution results are incorrect.

**A. Neutral capability contract.** The production
`apps/worker/src/execution/node-attempt-handler.ts` currently declares
`NodeAttemptCapabilityContext` and `NodeAttemptRuntimeCapabilityFactories`, yet
preview handling and both connection/artifact capability implementations consume
those shared types from that production handler.

Move the shared type definitions to one execution-local contract owner, for
example `node-execution-capabilities.ts`, with neutral names such as
`NodeExecutionCapabilityContext` and `NodeExecutionCapabilityFactories`.
Update the production/preview handlers, `node-attempt-runtime.ts`,
`node-runtime-capabilities.ts` and `provider-connection-runtime.ts`. Preserve
existing exported aliases if required by supported consumers; do not add a new
package-root export or leave two independent type declarations.

Keep every context field, optional preview/retention field, factory timing,
readiness responsibility and close-ownership rule unchanged. Keep production
and preview policies separate. A type-only dependency cleanup is not a reason
to rewrite either handler's lease/heartbeat lifecycle.

Verification: worker typecheck; `node-attempt-handler.test.ts`,
`preview-attempt-handler.test.ts`, `node-runtime-capabilities.test.ts` and
`preview-attempt-runtime.test.ts`; existing activation/cleanup tests; architecture
checks. A static dependency assertion is appropriate for this import rule, but
not a replacement for behavioral tests.

Done for A: no implementation imports the production handler solely to obtain
the shared capability types; both execution modes satisfy one canonical contract;
public behavior and export surface are unchanged.

**B. Persisted executable projection verifier.**
`apps/worker/src/execution/coordinator-engine.ts#verifyProjection` and
`node-attempt-engine.ts#verifyProjection` independently implement the same
release resolution, already-admitted executable verification and envelope-epoch
agreement rule.

Create one worker-local `verifyPersistedWorkflowProjection` implementation with
a narrow shared options contract. Keep the engines' existing exported option
names as aliases/intersections if necessary; the expression evaluator remains
node-attempt-specific. Both engines must call the shared implementation and
remove their predecessor algorithms in the same change.

Preserve:

- Resolution by the pinned admission/current release descriptions and exact
  epoch/fingerprint; no implicit “latest” fallback.
- Existing behavior with or without `releaseSupport` and `currentRelease`.
- The missing-release and envelope/projection-epoch errors, checksum checking,
  verification order and `execution: { alreadyAdmitted: true }` semantics.
- Historical release overlap and immutable envelope/retry/checkpoint identities.
  Do not generalize API publication/replay/trigger verification into this helper.

Required cases through both engine consumers: valid pinned projection; missing
admission/current release metadata when support is selected; malformed envelope
or checksum; mismatched envelope epoch; supported overlap; unsupported release
identity; and unchanged node input/coordinator no-change behavior after success.
Reuse `apps/worker/test/coordinator-engine.test.ts`,
`node-attempt-engine.test.ts` and their fixtures. Add shared test cases only when
they improve coverage rather than copy the two suites.

Done for B: exactly one worker implementation owns this policy, both public
engine suites still exercise it, and a removed epoch/support check is detected
by the relevant consumer tests. No new adapter or public framework is introduced.

### Q9-05 — Reduce duplicated knowledge only where semantics truly match

Two bounded conditional comparisons; no broad utility extraction.

**A. API authenticated command context.** Targets:
`apps/api/src/workflow-authoring/controllers.ts`,
`workflow-runs/controllers.ts`, `connections/controllers.ts`,
`node-testing/controller.ts`, `artifacts/controllers.ts` and
`identity-workspace/controllers.ts`.

The helpers for actor selection, optional guard authorization and request/trace
identifiers repeat across these consumers. Unlike the already-fixed request-type
duplication, their error mapping and transport behavior are not identical.

First enumerate each variant: actor from the guard versus session; absent guard
context; invalid actor construction; optional request/trace data; feature error
mapping; and any transport-specific values. Compare retaining the helpers with
one small identity/workspace context projector for the genuinely common successful
path. Keep feature error wrappers, `traceparent` parsing, SSE reauthorization,
raw socket capabilities and feature parameter parsing local.

Do not recreate failure-notification destination composition, which already has
an explicit command-context owner. Do not let a “shared” helper require a bag of
error callbacks, feature flags and optional transport dependencies that is harder
to understand than the existing code.

Required tests: the existing controller suite for each migrated feature must
preserve session-derived actor, guard-derived actor, request/trace propagation,
invalid-actor error/status behavior and authorization loss. Reuse the respective
`apps/api/test/<feature>/controllers.test.ts` files and
`test/node-testing/controller.test.ts`. SSE still needs its owning transport
tests, not just a context-helper test.

Done for A: one owner exists only for identical semantics, intentional feature
differences remain visible, and no wire schema/use-case input change occurs.
A justified retention is preferable to a universal HTTP-context abstraction.

**B. Nested graph traversal for identity-derived reports.** Target
`packages/workflow-model/src/graph/identity.ts#workflowIntegrationUsage` and
`#compatibilityForGraph`. Both independently walk nested graph bodies and build
deduplicated, ordered identity-derived results.

Compare the current two walks with a private ordered node traversal reused by
both. The graph remains the authority; reports remain disposable projections.
Do not combine their distinct policies: connection-slot requirements and
integration usage are not unknown-definition compatibility checks.

Characterize nested bodies, duplicate definition identities, repeated integration
references, unknown definitions, missing required connection slots and stable
output ordering. Test node/edge permutations where the existing graph contract
declares order immaterial; preserve diagnostic ordering where it is material.
Keep graph/executable checksums, catalog fingerprints and historical fixtures
unchanged. Reuse `packages/workflow-model/test/graph.test.ts`,
`workflow-graph-contract.test.ts` and the pinned workflow fixtures.

Done for B: changing how nested nodes are enumerated has one local owner without
changing report/error semantics or adding a new public graph abstraction. Retain
two explicit short walks if the helper adds indirection without reducing shared
knowledge. Registry/release assembly must also be checked for the same applicable
duplication/invariant-ownership patterns. Preserve its distinct authority where
justified; do not turn the scan into an unrelated registry redesign.

## Part 4 — Runtime, data and error safety

### Q9-06 — Make boundary differences and failure contracts executable

Required contract/evidence work; code fixes only for reproduced violations.

There is no newly confirmed production-safety defect behind this item. Existing
provider, cancellation, fencing, cleanup and lost-COMMIT fixes remain closed.
The remaining code-quality opportunity is to make assumptions at the selected
interfaces explicit and check their composition without relying on deployment.

**A. JSON/value boundary matrix.** Targets:
`packages/workflow-model/src/canonical-json.ts`,
`packages/node-sdk/src/json-boundary.ts`,
`packages/database/src/execution/stored-execution-value.ts`, and their existing
public-consumer tests.

- Record each contract's input domain, bytes/depth/member limits, normalization,
  invalid-value behavior and caller. These are versioned contracts with genuine
  differences; do not replace them with one universal serializer.
- Map existing cases for null/booleans/numbers, negative zero, escaped/Unicode
  strings, arrays/objects, sparse arrays, cycles, accessors, symbols, prototypes,
  non-finite numbers, NUL/unpaired surrogates and explicit `toJSON` behavior.
  Do not assume all three surfaces accept or reject the same values.
- For inputs in the supported intersection, prove that the actual node-output
  to stored-value to loaded-input path preserves the intended value and identity.
  For intentional mismatches, prove the appropriate owning rejection or explicit
  conversion; never silently truncate or widen a contract.
- Exercise exact bounds and one-over-bound cases independently for bytes,
  members and depth using the current named limit constants. Existing tests
  count when they assert the relevant result. A small fixed-seed valid corpus
  plus one-field invalid variants is sufficient; no unbounded random campaign.
- Use hand-authored expected normalized values and versioned fixtures. Do not
  derive the expected answer by calling the same implementation under test.

Reuse `packages/workflow-model/test/canonical-json.test.ts`,
`packages/node-sdk/test/registry.test.ts`, the existing database stored-value
tests and `execution-value-persistence.integration.test.ts`. Add only absent
cross-interface cases. Keep browser-safe code free of Node-only imports.

**B. Failure contracts across all applicable owners.** For every occurrence
identified by Q9-06B's repository-wide scan, including Q9-02 through Q9-05 and
Q9-09 consumers, record and protect the applicable rows below:

| Boundary | Required failure contract |
| --- | --- |
| Input/identity validation | Reject at the existing phase; no new query, provider call or transition after decisive invalid input |
| Database read/transaction | Preserve real role, workspace, snapshot/lock lifetime, fence and cleanup; a helper cannot acquire its own hidden client |
| Projection/compatibility | Preserve pinned identity and error category; invalid data cannot become an admissible execution plan |
| Capability construction/use | Keep production/preview context differences, signal propagation, secret ownership and existing close responsibility |
| Cancellation or stale ownership | Preserve durable uncertainty and fencing; do not synthesize a terminal result from queue state |
| Primary failure plus cleanup/output failure | The awaited operation fails, primary information remains visible, cleanup is attempted and owned resources do not escape |
| Evidence validation | Invalid output cannot be labeled complete or make full qualification pass |

Use the existing real composed and process tests for already-compliant rows,
with an explicit occurrence-to-evidence link. Fix the same error/ownership
problem in every affected owner, even if that owner was not among the initial
refactor targets. When a refactor touches a row, rerun its owning evidence and
add a missing combined-fault case only if needed. Keep the already-fixed repeated
stdout/stderr/callback failure regressions and seven canaries; do not redesign
their policy again.

Done when: every applicable interface states its relevant failure/ownership contract,
the matrix distinguishes intentional differences from defects, and exact owning
tests protect any behavior this plan changes. Any actual violation needs a
reproduction and focused regression before a fix—not a speculative policy change.

## Part 5 — Tests and verification

The current test section is already approximately 9/10. Preserve its strengths;
the aim is better proof and faster focused feedback, not a larger test count.

### Q9-07 — Link integration review evidence to actual run results

Required verification improvement, not a reopening of N06.

Targets: `infrastructure/report-risk-coverage.mjs`, its tests,
`infrastructure/risk-coverage-reviews.json`, `infrastructure/run-local-quality.mjs`,
its tests, and `docs/operations/test-confidence.md`.

Current condition: the reviewed inventory truthfully permits
`evidenceState: referenced-only`. The named artifact-reference, HTTP-attempt and
preview-delivery cases did execute in the final worker integration report, but
those links are not automatically promoted to source-matched execution evidence.
Do not misdescribe this as five newly uncovered defects.

Required work:

1. Reuse the existing integration-evidence schema and named-test matcher. Supply
   run-scoped result artifacts to the report once required integrations finish.
   Do not hard-code a timestamped run path into the committed review manifest.
2. Bind execution evidence to the exact source candidate and command. Preserve
   the distinction between the risk-file content digest and the complete local
   candidate identity; one is not a substitute for the other.
3. Since coverage currently runs before service integrations, enrich or validate
   the final evidence after those reports exist. Do not let early coverage read
   a previous run's integration report and label it current.
4. Keep standalone coverage/partial runs honest: they may remain referenced-only
   when no matching execution exists. Full qualification must reject missing,
   failed, skipped, malformed, wrong-test, wrong-source or stale required evidence.
5. Add negative fixtures for each failure above, plus duplicate titles in another
   file, a passing unrelated test, and a stale artifact copied into a new run.
   The valid case must use the same wrapper/format the real runner emits.

Done when: current full evidence links each selected integration review to a
passed named test automatically; partial evidence is still distinguishable; and
reviewed-but-uninstrumented decisions are not advertised as unit execution.

### Q9-08 — Keep tests at the owning interface and make focused runs explicit

Required for all applicable occurrences and affected consumers in the inventory,
including justified retentions that reuse existing tests.

Targets: affected test files named by Q9-02 through Q9-06,
`docs/operations/local-quality-verification.md`, `docs/operations/test-confidence.md`,
root/package scripts and CI only if needed for discovery.

Required work:

- Before adding cases, map every acceptance scenario to existing assertions.
  Extend an owning suite instead of copying a large fixture into a new suite.
  Preserve hand-authored historical fixtures and real PostgreSQL/queue tests.
- Prefer outcomes through the public operation. Private pure-projection tests
  are useful for a dense decision table, but they do not replace tests through
  the real loader, coordinator or application consumer.
- Remove predecessor tests only after naming the surviving stronger assertion.
  Do not delete security negatives, historical compatibility or real transaction
  tests because a mocked helper test is easier to maintain.
- For each changed policy family, demonstrate one decisive negative/control or
  disposable red/green mutation. Reuse the existing seven canaries where they
  protect the same invariant. Do not duplicate them just to increase the count.
- Record a focused verification recipe per work item: package build/typecheck,
  exact unit files, required integration cohort, flags/services and expected
  report. Use existing commands and runner-owned disposable services.
- Measure focused command duration and the final full-run duration. Identify
  duplicate builds or repeated fixture setup only if the profile shows real
  waste. Do not add retries, skip required tests, parallelize fixed coverage
  writers, or replace real-service proof with mocks to obtain a faster number.

Required recipes at minimum:

| Change | Fast feedback | Wider evidence when behavior can change |
| --- | --- | --- |
| Navigation only | Targeted formatting, docs and diff checks | None unless code/import contracts changed |
| Pure parser/projection | Owning parser/projection unit cases and package typecheck | Historical compatibility and its real persistence/engine consumer |
| SQL-adjacent input loading or purge | Owning unit cases and database typecheck | Selected real-role database/worker/lifecycle integrations |
| API/worker interface change | Owning controller/handler/module tests and typecheck | Relevant HTTP/queue/provider integration cases |
| Evidence generator/validator | Node runner/comparator/report tests | A real emitted artifact and final full qualification |

Done when: another AI can run the correct narrow checks without guessing, all
new cases run through normal scripts, and test changes reflect behavior rather
than the arrangement of helper functions.

## Part 6 — Local performance and resource discipline

### Q9-09 — Validate real benchmark output before qualification can succeed

Required. This is a confirmed remaining automation gap.

Targets: `infrastructure/performance/run-local-benchmark.mjs`,
`compare-local-benchmark.mjs`, both test files, `infrastructure/run-local-quality.mjs`,
its tests, and the owning root scripts.

Current condition: schema-v4 artifacts and comparisons are valid. However, the
benchmark writer serializes the result of `benchmark()` without applying the
comparator's complete evidence validator. The full runner treats a successful
producer exit as a passing performance cohort. Synthetic validator tests alone
cannot guarantee that a newly emitted real artifact satisfies that contract.

Required work:

1. Give the evidence contract one callable owner, such as an exported
   `validateBenchmarkEvidence` function. Reuse the existing checks rather than
   copy them. Keep it free of CLI execution side effects and dependency cycles.
   A new file is optional, not the objective.
2. Validate the actual generated object before marking/writing a successful
   artifact. The comparator must call the same validator for both inputs. The
   full runner must not mark its performance cohort passed if validation fails.
3. If validation needs a file round-trip, retain an explicit failed/partial
   artifact or use an owned temporary output; never leave a complete-looking
   success artifact after a validation/write/close failure. Preserve exclusive
   creation, primary/cleanup failure reporting and resource cleanup.
4. Preserve all schema-v4 checks: source/environment identities, raw measured
   rounds and derived summaries, exact operation contracts/populations, positive
   target SQL for runner-owned databases, permitted zero base SQL, and required
   PostgreSQL/process observations. Do not fix the gate by relaxing validation.
5. Add a producer-to-validator test using the actual producer result shape, not
   just a hand-crafted comparator fixture. Corrupt an emitted result in turn:
   missing target block; zero target calls; missing marker; mismatched summary;
   missing raw round; invalid environment; and partial status. Each must make
   the owning command/cohort fail, with cleanup still observed.
6. Validate a real retained compatible artifact, then the newly generated final
   artifact. Self-comparison and a compatible baseline/candidate comparison must
   pass. Incompatible artifacts must fail for their intended reason.

Done when: generation and consumption cannot silently disagree, and a producer
regression is caught by normal qualification. Do not create a new measurement
version merely for moving validation; version only an actual contract change.

### Q9-10 — Prove bounded work across applicable code-path families

Required measurement; optimization conditional on a demonstrated bottleneck.

Targets: selected input/checkpoint/engine paths from Q9-02/Q9-03,
`packages/workflow-model/src/graph/validation-contract.ts`,
`packages/workflow-engine/src/checkpoint-v1.ts`, their owning tests, and the
existing local performance tooling and evidence documentation.

Current limitation: the eight scenario measurements are useful operation-level
evidence, but several populations are deliberately tiny (one webhook admission,
one due schedule, a small publication fixture). They do not establish work/space
growth near supported input limits. This is a local code-performance question,
not a request to prove production capacity.

Required work:

- Start with three bounded probes: input assembly with increasing upstream outputs;
  checkpoint validation/projection with increasing invocations and joins; and
  nested structured-scope lookup within the supported graph/checkpoint limits.
- Extend the probes to every distinct applicable work/resource pattern found
  by the repository-wide inventory. Reuse a probe across callers only when they
  demonstrably use the same implementation/contract, and record consumer-level
  protection. Do not benchmark only the original three examples while leaving
  another discovered unbounded or per-item-I/O path unaccounted for.
- Use a small, intermediate and upper-supported case for one axis at a time.
  Read the actual versioned limits; do not generate an invalid cross-product of
  maximum nesting, fan-out and iterations or invent larger supported limits.
- Record population, selected contract version, completed operation count, SQL
  query count where applicable, elapsed operation time and attributable memory
  information. Distinguish fixture/setup cost and orchestrator metrics from
  workload cost. Keep unavailable measurements explicitly unavailable.
- Assert structural bounds where the implementation promises them: upstream
  outputs stay batched rather than one query per item; no extra database client
  per item; loops/collections remain within their declared budgets; all owned
  resources are released. Do not invent universal O(n) requirements for a
  policy that legitimately compares graph relationships.
- If repeated scans or serialization dominate, compare a request-local index
  or one-time validation/projection against the current path. Use no global
  cache of mutable workflows, cross-tenant data or unbounded checkpoint state.
- Retain behavior if no bottleneck is demonstrated. If optimizing, retain
  independent before/after evidence with identical contracts/populations and
  run the semantic regressions from the owning work item. Do not add an index
  or migration without evidence; schema changes need forward compatibility.
- Keep short deterministic operation-count tests in normal feedback. Use the
  existing benchmark command for noisy repeated timings; choose a regression
  budget only after repeated stable measurements. Do not fail CI on an invented
  millisecond threshold or claim an application speedup from faster setup.

Done when: the initial probes and every additional applicable family have
reproducible valid populations and explicit work-growth results or current
equivalent evidence, no applicable occurrence is unaccounted for, no avoidable
per-item I/O regression was introduced, and any optimization has measured benefit
without semantic drift.

## Closeout — Q9-11

Required. After integrating all work:

1. Reconcile every item, every acceptance case, every discovered occurrence and
   every assessed section. Repeat the repository-wide family scan and account
   for remaining variants/callers on the final candidate. Include concrete
   evidence for each retained design and no-match area. Do not claim all done
   because a single command or the example files are green.
2. Review the cumulative implementation against Q9-00's dirty baseline. Trace
   final consumers and sibling paths; do not review only the last file edited.
3. Once code is stable, run `pnpm quality:local` for final qualification. Do not
   run a second identical full matrix merely to restate its result. If the run
   fails, diagnose and rerun affected checks, then obtain one clean final run.
4. Verify the real emitted benchmark artifact through Q9-09 and the run-linked
   evidence through Q9-07. Record source identities, reports, exclusions and
   cleanup. Required local services must execute; AWS exclusions remain separate.
5. Check that only owned services, locks, volumes, sockets and processes were
   cleaned up. Keep user resources and pre-existing dirty work intact.
6. Report the six code-quality scores once against the fixed rubric. For any
   section below 9, give the specific unmet criterion and evidence, not a vague
   recommendation for another whole-project audit. Report optional 10/10 stretch
   results separately. Do not invent deployment blockers for code-quality scores.
7. Distinguish a later report-only documentation delta from the qualified code
   fingerprint. Run targeted docs/format/diff checks for that delta.

Stop when all required items have evidence-backed dispositions and the rubric
has been assessed, with no pending, blocked or unclassified applicable occurrence
and no unmigrated consumer. Optional unrelated ideas do not keep this task open. An unresolved
confirmed safety defect or missing required proof blocks the affected item;
continue independent in-scope work rather than silently waiving it.

## Implementation ledger

Everything below starts pending. Existing Q/N completion is not completion of
these new deliverables.

### Coverage of the six sections and repository areas

| Section | Owning items | Must not be substituted with |
| --- | --- | --- |
| Naming and organization | Q9-01, Q9-04A, names in Q9-02/Q9-03/Q9-05 | A blanket file rename or another prose-only architecture document |
| Control flow and readability | Q9-02, Q9-03, Q9-05B | Line-count reduction that spreads invariant ordering across helpers |
| Responsibilities and interfaces | Q9-04, Q9-05, Q9-02 | A generic layer or public export for every private helper |
| Runtime, data and error safety | Q9-06 plus each changed consumer's tests | An assumption that local success proves deployed AWS behavior |
| Tests and verification | Q9-07, Q9-08, Q9-09, Q9-11 | More test files, blanket coverage labels or repeated identical full runs |
| Local performance/resource discipline | Q9-09, Q9-10 | A lower launcher duration, invented SLO or unmeasured cache/index |

| Repository area | Work or retained disposition |
| --- | --- |
| API | Q9-01/Q9-05A context ownership and navigation; preserve feature authorization, error and SSE differences |
| Worker | Q9-04's two concrete ownership fixes; preserve the completed activation, provider and handler lifetime behavior |
| Database | Q9-02 input projection and Q9-03A invariant families; preserve purge, SQL authority and existing transaction owners |
| Workflow engine/model | Q9-03B matching proof, Q9-05B traversal comparison, Q9-06 value boundaries and Q9-10 bounded work |
| Node SDK/catalog/core nodes | Q9-06's existing JSON/registration consumers and compatibility gates; no speculative registry/cohort rewrite |
| Artifact store/integrations | Reuse Q9-06's composed value, secret, dispatch and cleanup proof; no new provider policy or ledger implementation |
| Queue/rate-limit/observability | Preserve admission, abort, backpressure and diagnostic-isolation contracts; rerun affected consumers if touched, with no forced package rewrite |
| Lifecycle/operator/recovery/retention apps | Keep their narrow authority and existing process/transaction tests; purge/recovery remain explicit retained designs |
| Contracts/build/infrastructure | Preserve wire and built/browser exports; Q9-07/Q9-08/Q9-09 strengthen evidence plumbing and verification discovery |
| Documentation | One current status route, this plan's ledger and concise change recipes; preserve historical evidence |

Coverage means a repository-wide per-family scan and an explicit disposition,
not edits to every package. The routing table names known starting work, not
package exemptions. Retained areas must still be checked for every applicable
identified improvement. Only unrelated new improvement families are excluded.

### Required occurrence inventory

Maintain the following tables here or in one linked companion record. Do not
mark them complete merely because templates exist. Populate them during Q9-00,
update them throughout implementation, and reconcile them in Q9-11.

**Scan coverage:** one row per actual application/package/infrastructure area
and improvement family. Enumerate subdirectories/entrypoints sufficiently to
make exclusions visible; an aggregate “all packages” row is not sufficient.

| Area / scanned paths | Improvement family | Queries and semantic/reference checks | Candidate source identity | Matching occurrence IDs or justified no-match result |
| --- | --- | --- | --- | --- |
| To inventory | To inventory | Pending | Pending | Pending |

**Occurrence record:** one row per candidate symbol/behavior and its consumer
group; split the row if its consumers have different contracts or outcomes.

| Occurrence ID / Q9 family | File, symbol, invariant and consumers | Applicability and decision | Status | Change or retention reason | Named assertions, executed results and source | Final rescan / remaining references |
| --- | --- | --- | --- | --- | --- | --- |
| To inventory | Pending | Pending | pending | Pending | Pending | Pending |

Use these statuses precisely:

- `improved`: the applicable change is implemented and all affected consumers
  are verified; identify consumers fixed through a shared owner.
- `already compliant`: the current implementation already satisfies the rule,
  with direct source and test evidence.
- `intentionally retained`: the required conditional comparison demonstrates
  that the existing implementation is preferable or has different semantics;
  include the specific contract and relevant evidence.
- `not applicable`: the inspected match does not implement this improvement's
  pattern; explain why rather than use it as a waiver for hard work.
- `pending`, `in progress` or `blocked`: work is not complete. For a blocker,
  identify the exact missing proof/input and continue independent occurrences.

For each family and each of the six sections report totals for discovered,
improved, already compliant, intentionally retained, not applicable and
unfinished occurrences. Totals must reconcile without dropping discovered rows;
unfinished applicable occurrences must be zero before declaring completion.
One shared fix may cover many occurrences, but each must retain its consumer
and verification link. Report new matches found by the final scan as well.

| ID | Status | Decision / exact change | Acceptance evidence | Remaining limitation |
| --- | --- | --- | --- | --- |
| Q9-00 | pending | — | — | — |
| Q9-01 | pending | — | — | — |
| Q9-02 | pending | — | — | — |
| Q9-03 | pending | — | — | — |
| Q9-04 | pending | — | — | — |
| Q9-05 | pending | — | — | — |
| Q9-06 | pending | — | — | — |
| Q9-07 | pending | — | — | — |
| Q9-08 | pending | — | — | — |
| Q9-09 | pending | — | — | — |
| Q9-10 | pending | — | — | — |
| Q9-11 | pending | — | — | — |

For each item record the source identity, existing tests reused, alternatives
considered, implementation or justified retention, removed predecessor path,
exact acceptance results, focused commands, performance impact and unresolved
limits. At checkpoints report all six sections, including those unchanged,
and the occurrence totals, scan coverage and remaining migration work for each.

## Copyable implementation instruction

> Read AGENTS.md and this entire code-quality plan. Implement all required local
> deliverables Q9-00 through Q9-11 and evaluate every conditional refactor using
> the specified evidence. Named files are examples, not scope limits. For every
> identified improvement, search the entire owned repository, inventory all
> applicable occurrences, implement it consistently everywhere it applies, and
> verify every affected consumer and sibling path. Record specific evidence for
> already-compliant, intentionally different or non-applicable occurrences;
> never stop after the examples or easiest subset. Repeat the scan at closeout
> and reconcile every occurrence with zero unfinished applicable work. Preserve
> completed Q/N fixes and existing user work. Maintain the occurrence inventory,
> ledger and all six section dispositions. Use focused verification
> during implementation and one clean, source-stable full qualification at the
> end. Do not weaken contracts, gates or independent fixtures; do not refactor
> merely to shrink files. Assess code quality against this plan's fixed local
> rubric, with deployment readiness explicitly separate. Record real blockers
> and continue independent work. Do not deploy, use live providers, spend money,
> commit or push without separate authorization. Finish with exact changes,
> verification evidence, all six scores and remaining limitations; do not expand
> the task into another unbounded audit cycle.
