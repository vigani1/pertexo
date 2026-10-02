# F08 — Reusable subworkflows with durable parent/child runs

Status: accepted ADR065; implementation in progress, callable contract and executable foundations verified.
Decision preparation is authorized; primary selected strict independent occupancy
and fail-fast child admission for the V1 proposal on 2026-10-02. The complete
contract/ADR was accepted at `b6c2998d29408b086c289e87058f9c67d2008ff2` after
primary source review and independent Standards/Spec closure.
Primary additionally selected bounded portable closed-object contracts, exact
same-workspace pins, depth-four/64-child/1,000-expanded-work bounds,
configuration-only preview, conservative membership-revision authority and
immutable publication/root family-deadline policy. Transaction/privilege and
independent design review closure are complete; executable proof remains pending.
Created: 2026-09-28. Parent: [product roadmap](../product-roadmap.md).
Scope: New execution capability across both stacks. Relative size: **XL**, not a calendar estimate.

## Outcome

One published workflow calls a reusable published child with typed inputs/results and inspectable parent-child history.

## Current implementation and evidence

Nested For Each bodies exist inside one run; they are not reusable child workflows. Subworkflows remain explicitly deferred in the backend plan.

Inspected anchors (paths may move during the concurrent structural cleanup):

- [docs/workflow-platform-backend-plan.md](../../docs/workflow-platform-backend-plan.md)
- [docs/adr/020-bounded-for-each.md](../../docs/adr/020-bounded-for-each.md)
- [packages/workflow-engine/src/index.ts](../../packages/workflow-engine/src/index.ts)
- [apps/api/src/workflow-runs](../../apps/api/src/workflow-runs)

“Not established” means no complete product was found in this targeted inventory,
not proof of absence from every file. Recheck these anchors before implementation.
Code availability is not a fresh end-to-end verification claim.

## Dependencies and planning gate

01 and 02 recommended; 05 for later portable dependency bundles. Design early; implement after current engine cleanup.

Recommend wait-for-result only first, no recursion/cross-workspace calls. Define who authorizes child use, parent deadline propagation, accounting, deletion/pinning and outcome_unknown propagation.

Recommendations are not accepted ADRs. Resolve consequential choices before code;
use the next free ADR number when required. Do not create ADRs for routine fixes.

Current bounded decision evidence is in the
[contract proposal](08-subworkflow-contract-proposal.md) and
[ADR065](../adr/065-durable-parent-child-workflow-calls.md), accepted on 2026-10-02.
A waiting parent retains its
ordinary active slot. Fresh child acceptance must reserve an independent ordinary
slot with existing FIFO/entitlement checks or fail definitely with no child;
cap one cannot execute nested calls, and any full workspace can refuse a call.
Do not silently implement an extra child pool or conserved-token redesign.

Callable result-selector guidance: select a root-graph node with exactly one
successful durable invocation. Missing/skipped/non-success selection or multiple
successful scoped invocations fails result validation, even when their values
are equal; use an explicit unique root result-producing node instead of expecting
last-value selection or implicit aggregation. Expression-referenced outputs have
the same uniqueness rule. The future editor must explain this rule beside the
selector, without pretending this guidance is already an implemented picker.

## Ownership and structure

Model/SDK callable contract; engine call decisions; database parent-child admission/settlement; worker dispatch; contracts; web editor and run history.

Follow the [shared implementation rules](../product-roadmap.md#shared-implementation-rules).
These are responsibility owners, not a mandate to create empty folders/packages.
Reuse the post-cleanup canonical owners; do not restore old duplicated paths.

## Frontend work

Callable workflow input/output editor, Call Workflow node, exact-version picker/upgrade notice, parent/child run links and waiting/failure/cancel presentation.

## Backend work

ADR before schema: pin child immutable versions, durable invocation→child-run identity and idempotent spawn, authorization and entitlements, terminal completion wakeup/outbox, parent result projection. Parent waiting must release worker slots; no in-process recursive executor.

## Delivery slices

1. Define same-workspace typed call contract, pinning and acyclic dependency limits; reject recursion initially.
2. Implement idempotent child acceptance/completion and cancellation/deadline/failure behavior through engine/database/worker owners.
3. Deliver configuration and run lineage; later explicit extract-selection and asynchronous fire-and-forget modes.

Each slice ends in a usable, tested behavior; do not ship enabled placeholder
controls backed by invented responses.

## Acceptance evidence

Crash before/after spawn, duplicate wakeup creates one child, child wait/restart, two callers, changed publication cannot mutate in-flight pins, revoked access, cancellation race, parent resumes once.

Apply the shared completion checklist: contract/authorization tests, real
persistence and restart/race tests when relevant, real browser/backend flow for
visible behavior, and exact reviewed source/CI evidence. Mocks alone cannot close
the live gate. Record unsupported environments explicitly.

## Non-goals

HTTP workaround calling our own public endpoint, child work within occupied parent slot, copying subgraph code as runtime invocation.

## Rollout and rollback

Disable new call-node publication; preserve readers/executors and child settlement for accepted runs.

No production rollout, paid provisioning or real external calls are authorized by
this plan. New persistent behavior requires additive reader/writer rollout and
retention/membership-deletion handling before enablement.

## Competitor context

Zapier Sub-Zaps, n8n subworkflows and Make subscenarios all expose reusable calls. Their semantics are references, not permission to weaken Pertexo pinning. Sources: [Zapier Sub-Zaps](https://help.zapier.com/hc/en-us/articles/8496308527629-Create-reusable-Zap-steps-with-the-Sub-Zap-app); [n8n subworkflows](https://docs.n8n.io/build/flow-logic/break-workflows-into-smaller-parts); [Make subscenarios](https://help.make.com/subscenarios).

Research checked 2026-09-28; product editions and availability can change.
This context informs the outcome, not Pertexo's implementation or billing policy.

## Delivery tracker

- [x] Baseline reconciled against current code and accepted decisions.
- [x] Product choices resolved; necessary ADR accepted.
- [x] Contracts and failure/security design reviewed (implementation proof pending).
- [ ] Backend behavior implemented and independently verified where needed.
- [ ] Frontend behavior implemented and independently verified where needed.
- [ ] Real integrated acceptance evidence recorded.
- [ ] Rollout/rollback and limitations documented.
- [ ] Scoped PR merged with required checks; natural postmerge result inspected.

Evidence log: complete plan and relevant current ADRs/contracts inspected against
accepted F07 `e7d25e1f85342f10ae0044aadd408d88c49ea993`; exact anchors, proposal
interfaces, capacity/authority/deadline/retention decisions and verification seams
are recorded in the contract. Primary accepted ADR065 at exact `b6c2998d`, tree
`777b902351dd2a0fee2b067993ede3bc4ab1364c`, after both original independent
reviewers closed their design P1s with zero remaining actionable delta findings.
Primary subsequently accepted release-qualified integrated F07 base `0b4e0810`,
tree `27c2362ba58c9eb161335d89a6665200403d8052`, and exclusive migration0136
allocation, authorizing full implementation. The browser-safe portable type
descriptor, bounded runtime value validator and reusable inspector type field
are implemented. On Node24.15.0/pnpm11.22.0, the model suite passes 1,433 tests
across 19 files and the focused editor suite passes 16 tests with no skips.
Model build, web typecheck (after building engine/catalog prerequisites), narrow
lint/format checks, browser-condition built import and browser dependency
traversal pass. The exact browser allowlist exposes only the descriptor contract;
runtime validation remains behind the server model facade. Post-staging React
Doctor is unchanged at 89/100 with 12 existing F07 advisories and no new callable
diagnostics. This field is not yet wired into a callable workflow graph and does
not expose a runnable placeholder. The internal same-client transaction adapter
now supplies both existing workspace transaction wrappers without owning scope
or connection lifecycle. Its focused regression and transaction engine tests
pass (35 tests), as do all 1,032 database unit tests across 135 files, database
build/typecheck and narrow lint/format checks. It is not yet connected to child
acceptance and grants no public client-adaptation API. No persistent F08 schema,
child execution, restart proof or live UI evidence exists at this checkpoint.

The explicit guarded Graph V2 grammar, exact child pins, required immutable
family policy and pure closure verifier are implemented separately from retained
V1 parsing. Closure verification counts repeated sites and loop products, rejects
workflow-identity recursion, and enforces depth four, 64 children and 1,000
expanded invocations. Existing structural rules and restricted path/expression
owners validate callable selectors; the closure index contains pins, not copied
graphs. All 1,488 model tests across 22 files pass, including retained V1 and
hostile-input cases. Model build/typecheck, narrow lint/format, complexity and
module-import checks pass; built browser-condition imports and dependency
traversal prove the graph/pin leaves safe and closure leaf server-only. These
contracts are not yet wired into publication, persistence or the editor.

Executable V3 separately hashes the Graph V2 callable declaration, required
family policy and new scheduler/checkpoint/timeout/cancellation policy identities.
Retained V2 compilation and parsing reject Call nodes even when a future catalog
recognizes their definition. Pure Call input and explicit result helpers preserve
the existing bounded JSON and restricted expression owners, validate the exact
callable identity, reject hostile accessors and normalize cancellation without
swallowing operational evaluator failures. All 464 engine tests across 41 files
and 129 core-node tests across eight files pass. Engine/core typecheck, engine
build, narrow lint/format, module-import and complexity checks pass. The pure
declaration executor performs no child admission or provider I/O and is not yet
registered. At this executable-foundation checkpoint, V3 was not yet accepted
by advance/attempt runtime owners; native engine integration is recorded below.
Durable Call output must remain distinct from the immutable declaration attempt;
existing 256 KiB inline persistence cannot silently stand in for the independent
1 MiB callable value limit.

Standalone Checkpoint V3 and pure Call reconciliation now preserve separate
declaration-attempt input and child-result references, exact journal identity,
dedicated waiting, bounded Call ledgers, monotonic stops and unknown-outcome
precedence. All 590 engine tests across 43 files pass, with engine typecheck,
narrow lint and complexity checks. Retained checkpoint grammars remain separate
from the new wire format. The existing inline
owner supplies an independently tested representation selector; its 256 KiB
limit is unchanged. The standalone framework artifact codec admits source-local
1 MiB JSON, spills only through protected reservation callbacks, and verifies
same-workspace metadata, canonical byte integrity and availability before
hydration. The reserved-ID adapter reuses the existing spool/upload/finalize
owner without a second quota charge or fabricated attempt identity. All 1,011
worker tests across 80 files and 1,035 database unit tests across 136 files pass;
worker/database build and typecheck, narrow lint/format and module-import checks
pass. SQL callback authority/provenance and live storage qualification are still
required; these adapters are not registered.

The existing pure advance/attempt seam now accepts authenticated Executable V3
only with Checkpoint V3; retained artifacts retain their existing checkpoint
formats and reject Call material. Physical declaration success requires exact
attempt/output material, becomes a dedicated wait, and emits an atomic journal
intent rather than a fabricated child result. Actual mapped input is validated
against the retained callable identity before execution; declaration output must
equal that input. Call declarations never receive a new logical retry. Accepted
children remain waiting through parent stops until immutable terminal facts
reconcile; unknown outcomes outrank cancellation, timeout and ordinary failure.
ForEach waits preserve active ordinals and child results unlock downstream
readiness through separate scoped references. V3 source values keep independent
1 MiB budgets without descriptor-envelope overhead or duplicate retained copies;
retained V2 wrapper bounds and restricted-expression aggregate bounds are
unchanged. All 659 engine tests across 46 files pass, with engine build/typecheck,
full package lint/format, complexity and module-import checks. Database unit
tests (1,035) and worker typecheck also pass against the engine seam. Durable SQL
admission/settlement, physical reconciliation, worker/catalog registration,
publication/editor wiring, retention, and all live qualification remain unfinished.
V3 coordinator completed-output hydration now applies the same source-local
budget as V3 attempt input: aggregate identity metadata is bounded separately,
each source can reach 1 MiB without descriptor overhead, and the existing
persisted-outcome binding remains mandatory. Retained V1/V2 batch bounds are
unchanged. All 667 engine tests across 47 files pass, including exact-limit
advance, oversized-source rejection, bounded metadata and hostile containers.
This does not register callable result persistence or terminal settlement.
Authenticated V3 advance now completes callable success through the existing
explicit selector/type owner before returning its one terminal transition. A
selected root node must have one successful durable scoped invocation/output;
zero/multiple matches fail definitely, including equal-valued scopes. Source
hydration must match the exact invocation/output reference; missing hydration or
reference mismatch remains operational, not fabricated child failure. Result
values are transient, independently bounded and absent from the checkpoint;
physical successful attempts remain unchanged when typed result validation
instead fails the run. Existing expression ownership now inspects bounded AST
dependencies: static paths/lookups select their root outputs, while whole/dynamic
context access requires all root outputs to be unambiguous. Run-input-only
expressions do not reject unrelated ambiguous outputs. All 687 engine tests
across 48 files and 1,533 model tests across 23 files pass. Protected result
persistence, actual terminal/wakeup wiring, coordinator V3 registration and
source-bound service qualification remain unfinished.
The published execution reader now distinguishes the exact Graph V2 / Executable
V3 outer format from retained V1 and Executable V2 projections. The worker's
existing private artifact verifier authenticates V3 against its exact admission
catalog and supported current catalog, including format-column and epoch
agreement; malformed or tampered V3 cannot fall back to V2. All 1,310 database
tests across 141 files and 1,019 worker tests across 81 files pass, with database
and worker builds/typechecks, API typecheck, narrow lint/format, architecture and
complexity checks. Execution handlers still reject V3 until their protected
admission and settlement owners are wired; this reader extension does not enable
fresh roots, publication, Call execution or migration0136.
Callable compilation now rejects statically impossible selected outputs: direct
disabled nodes and expression dependencies on absent, nested or disabled root
outputs. It reuses the existing bounded expression dependency owner. Unreferenced
disabled nodes remain legal, and a uniquely scoped branch output is not rejected
merely for being scoped. The existing topology compiler rejects branch
reconvergence before Merge; no parallel scope scanner or selector grammar was
introduced. All 1,539 model tests across 23 files and 688 engine tests across
48 files pass. This is pure artifact validation, not publication-service wiring.
The standalone database Checkpoint V3 codec now validates the persisted wire
format independently of the engine, retaining the existing whole-checkpoint
256 KiB limit and strict physical-input/child-result separation. Its V2 projection
is validation-only and is never serialized or passed to execution. All 84 focused
codec tests pass. The retained run-acceptance contract and canonical write sequence
have also been extracted without changing legacy triggers, receipt replay,
notification locking, deadlines or inline persistence; 11 orchestration regressions
cover that seam. All 1,130 database unit tests across 138 files pass, with database
build/typecheck, narrow lint/format, module-import and complexity checks. The new
codec is not registered with persistence owners. Migration0136 is being assembled
outside the executable migration directory until protected admission, writer
fences and retention are complete; no SQL or live-service qualification is claimed.
Canonical acceptance now has a strict internal Call branch: only parent/revision/
invocation context is caller-provided, while the narrow SQL proof derives input,
pin and deadline. It reuses canonical ID allocation, claim, run/event/Checkpoint V3
and outbox persistence, then reserves before completing the claim. Recorded child
identity bypasses fresh policy and generic receipt replay. Only explicit typed
proof outcomes become refusals; arbitrary SQL errors retain their identity for
the outer rollback owner. All 147 focused admission/acceptance tests and all 1,277
database unit tests across 140 files pass. These are mocked protocol tests, not
SQL/savepoint or race qualification. The branch remains unregistered: the SQL
proof/reservation bodies, held prerequisite locks, candidate savepoint recovery,
durable journal and parent CAS integration are still unfinished.
The sequential candidate savepoint boundary now removes acceptance writes only
for typed refusal/ancestor-stop outcomes and returns them to the outer journal/CAS
owner. Unexpected errors escape for whole-transaction recovery; failed rollback
or release retains both errors and cannot manufacture a refusal. Its 25 focused
protocol tests pass, and the full database suite passes 1,302 tests across 141
files after additive integration of verified main `ed9116b9`. Build/typecheck,
narrow lint/format, complexity and architecture checks pass. This helper is also
unregistered; real prerequisite-lock retention and rollback behavior require the
unfinished SQL owner and owned PostgreSQL race qualification.
The private coordinator admission pass now validates one bounded parent/revision
context, reuses the existing compatibility wire projection, acquires prerequisite
locks once before all candidate savepoints, and journals each definite outcome
after candidate release. Candidates run sequentially on the same tenant-scoped
transaction; later operational or journal failures escape without a partial
result or seal. A separate post-CAS adapter supplies only parent/revision and
continuation identifiers to the SQL seal. All 22 focused orchestration tests and
1,332 database unit tests across 142 files pass, with database build/typecheck,
narrow lint/format, architecture and complexity checks. These are mocked adapter
tests, not serving-role, savepoint-retention or race qualification. The existing
coordinator commit owner is not yet wired to these operations, and no SQL grants,
migration registration or runtime enablement changed.

The unregistered SQL0136 draft now includes an atomic native child-terminal
parent identifier wakeup, retained-graph/checkpoint negative writer fences, and
fresh advance-outbox envelope/deliverability checks before reservation, journal
and seal. Isolated PostgreSQL18 development installation exposed and repaired
PL/pgSQL predicate syntax and forced-RLS receipt visibility; differential checks
also reject zero trace/parent IDs exactly as the existing queue contract does.
The full candidate at SHA256
`09fab7230eea62796c04b3f787366e188870a569e87ec2281744b7575d7277d3`
installs atop registered SQL0000–0135, and all 22 actual definer outbox-helper
cases pass using the existing canonical checksum and queue parser. Actual
catalog checks show 17 draft routines with no EXECUTE for any of the six serving
roles; rollout remains OFF. Every exclusively owned network-none/no-port/tmpfs
development database was removed, including failed runs. These are development
install/helper checks, not serving-role admission, reservation/journal/CAS whole-
transaction rollback, restart/race or usable-feature qualification. The draft
remains untracked outside the migration registry. Full native writer/retention/
readiness boundaries and coordinator/runtime/API/editor integration remain open;
none of the backend or integrated acceptance tracker items is complete.

Fresh Call declaration plans now request an immediate durable continuation and
leave other ready attempts unadmitted until the journal fact is consumed. The
following advance reconciles the existing Call and admits ordinary ready work
without declaring another child. All 660 engine tests across 46 files pass,
including that sequencing regression and retained grammars, with build/typecheck,
repository-root package lint/format, complexity and architecture checks. This is
pure scheduling evidence; the SQL continuation/CAS seal remains unqualified.
The existing closure verifier now derives root-owned expanded work and sorted,
immutable direct Call-site pin/multiplier metadata during the same bounded
traversal. Transitive child sites stay with their retained versions; no graphs or
callable types are copied into this metadata. Repeated/loop-multiplied sites and
callee-owned work remain independently accounted. All 1,491 workflow-model tests
across 22 files pass, including the direct/nested-loop and transitive separation
regressions, with model build/typecheck and narrow lint/format. Publication and
SQL persistence have not yet registered this derived metadata; these tests are
not publication, privilege, migration or usable-product qualification.
Existing foundations are not completion of F08. Mark genuinely inapplicable rows
with a reason rather than fabricating work.
