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
The worker's native attempt path now selects explicit V3 projections and reads
the exact retained callee version, checking workspace/workflow/version, executable
checksum and callable contract identity before providing its descriptor. Required
Call input recording is separate from the unchanged best-effort diagnostic writer.
Recovery reads protected snapshot metadata with the current lease/delivery and
hydrates/checks its original bytes before loading upstream inputs; it does not
remap, prepare, reserve or rewrite a committed snapshot. Engine tests cover changed
mappings and persistence failure before dispatch. Worker orchestration and SQL
adapter mocks cover recovery reuse, metadata mismatch and operational failures.
All 691 engine, 1,033 worker and 1,339 non-integration database tests pass, with
the affected package typechecks. These do not prove real lease reclaim or one child.
The unregistered SQL draft at SHA256
`7d0d3b410e9e5d9c080ae698e950ff51ff517df20f92a9afcaa1831377dfc86e`
installs in an exclusively owned network-none/no-port PostgreSQL18 tmpfs database;
all 21 draft routines remain ungranted to six serving roles and rollout remains OFF.
The database was removed. Required input function bodies are not yet qualified
with native run fixtures. Artifact reservation ownership, pending-upload cleanup,
physical completion aliasing, native source hydration and coordinator/result integration
remain unfinished; the existing preview-only artifact link cannot be reused as
execution ownership without an explicit additive owner fence. No F08 acceptance
row is complete from this evidence.

Node-attempt input loading now joins the actual retained workflow version and
selects Checkpoint V3 only for the exact Graph2/executable3/checksum-v3 pair.
Mismatched outer formats, a retained version carrying CP3, a native version carrying
CP2 and a different checkpoint workflow-version identity fail without fallback.
Retained Graph1/executable2/CP2 input loading and bounded loop/upstream query counts
remain covered. All 1,348 non-integration database tests across 144 files pass,
including nine mocked native/retained format-selection cases, with database
build/typecheck and narrow lint/format. This does not yet hydrate child-run artifact
inputs or journal-owned Call result outputs, nor qualify SQL writer authority.

The existing coordinator run-transition owner now returns its exact inserted
continuation outbox identifier privately after checkpoint CAS/run transition.
The public commit owner strips this internal identity from its result; it is not
transport or admission authority. Five mocked-client tests cover canonical payload/
checksum, write order, absent/terminal continuation, failed CAS and outbox failure.
All 1,353 non-integration database tests across 145 files pass, with typecheck and
narrow lint/format. Native V3 plan validation, admission integration and post-CAS
seal are still not wired into this owner; these checks do not close that gate.

The coordinator now has an explicit native plan/checkpoint seam and invokes the
protected prerequisite, canonical child acceptance, journal and post-CAS seal
inside its existing transaction. Call wait/settlement changes only the logical
node projection, retaining its real succeeded physical declaration attempt.
Terminal callable results bind the actual coordinator CAS and receipt; a deferred
fence rejects successful callable checkpoints without their result. Protected
child-result aliases now hydrate downstream inline inputs without rewriting the
declaration. Original input byte checksums and raw PostgreSQL references survive
the admission handoff. Retained codecs and old compatibility manifests remain
unchanged. At that milestone, cancellation plans and artifact result production
failed closed until their persistence owners were wired.

An exclusively owned PostgreSQL18 inline development flow on 2026-10-03 passed
parent→child→result→parent downstream→terminal with the actual runtime login,
published reader, worker coordinator engine, node claims/input/completion and
coordinator stores. Each node/coordinator delivery replayed without another
child, journal or result. Deliberately omitting the required child result rolled
back its terminal CAS, events, outboxes and receipt. The exact unregistered draft
SHA256 is `d2f8fca0becc2e62570617d5fba5cabd3523355004e1d8d50916ccb66966b249`.
This evidence uses explicit publication/root bootstrap, a distinct local native
compatibility fixture, temporary V3-only worker visibility and temporary native
EXECUTE grants. Visibility/grants were removed, rollout stayed OFF, registered
head/count stayed 0135/133, and the disposable database was removed. It is not
qualification of publication/root, permanent serving access/readiness, artifacts,
retention, cancellation propagation, API/editor, process restart or races. No
backend or integrated acceptance row is complete from this milestone.

Native coordinator completion now hydrates inline run-input, selected physical
node outputs and protected child-result aliases through the existing owners,
outside commit locks. It uses the established expression dependency inspector and
worker-supplied restricted evaluator, not a second selector grammar. Ambiguous
physical sources retain the engine's typed result failure; selected value reads
are paged. A child that becomes terminal before its parent's next advance can
supply a Call result during that same parent terminal transition. Owned
development runs passed run-input, node-output, restricted-expression and
parent-call-result variants, including result-omission rollback and duplicate
deliveries. These extend only the inline execution milestone above; the same
publication/root/visibility/grant carveouts apply. Normal native runtime lifecycle,
artifact hydration/ownership, child controls, permanent serving/readiness,
retention, API/editor and full qualification remain unfinished.

Existing foundations are not completion of F08. Mark genuinely inapplicable rows
with a reason rather than fabricating work.

The inline result milestone's fixed-point review identified selected-result
authentication and duplicated snapshot verification gaps. Coordinator commit now
recomputes the pinned result through the existing mapping/expression and callable
type validators using actual retained input/output owners before commit locks;
it requires the exact selected source list and value. The draft protected writer
also rejects direct literal substitutions and unexpected literal sources.
Child-result reads reuse the existing immutable snapshot verifier. Owned frozen
literal, run-input, node-output, expression and parent-Call-result variants passed
changed-value, wrong-type, undeclared-field, forged/missing-source and omitted
result rollback checks. These are narrow repair evidence, not serving-role or
full-feature qualification; nonliteral evaluation remains owned by the runtime's
existing restricted evaluator and must stay inside the authenticated coordinator
path. The unregistered writer remains OFF and all earlier carveouts remain.

Accepted-child cancellation and deadline propagation now use a narrow protected
column owner inside the existing parent CAS/receipt transaction. Existing run
event and outbox owners produce the child audit/wakeup; a private deferred seal
requires the parent next checkpoint, completed receipt and real fresh child
wakeup. Independently canceled or terminal children are unchanged. Deadline
propagation uses the existing deadline-wakeup marker, never cancellation columns.
Native plan validation rejects omitted propagation for any still-admitted child.

Chronological owned execution exposed a never-claimed scheduled-attempt gap:
the retained claim guard correctly blocked start after control, leaving the
logical running invocation waiting without terminal evidence. The existing
claim owner now has an explicit native-only control-settled outcome, proving
accepted native member/version authority and ready, fence-zero, never-started,
unleased, undispatched physical state under its existing locks/receipt. It records
truthful canceled/timed-out attempt/node facts through the existing event/outbox
owners without inventing a lease, start, dispatch or attempt. CP1/2 guards, live
and expired claims, and unresolved effects retain their existing behavior.
Owned cancellation, deadline, live independent-child cancellation and
child-terminal-first variants pass development checks, including duplicate
claims/commits/acknowledgments and unsealed-control rollback. Full qualification,
full concurrent races/restarts, permanent serving/root/publication/artifact/
retention/runtime/readiness/API/editor owners remain unfinished; no acceptance
row is complete from these controls. Raw nonliteral result-writer authority
remains explicitly open before any permanent grants or activation.

The existing database run-read/cancellation owner and public run response schema
now recognize native `workflow_call` provenance. Start/replay commands still
reject caller-supplied trigger provenance. The existing browser trigger label,
URL filter and local loaded-page filtering render Workflow call without new
queries, routes or duplicated state. A frozen owned API-role child read and
independent cancellation pass, as do 1,100 full web unit tests, five run-history
Chromium journeys, builds/types/lint and generated contract checks. The 390px
rendered filter/row was inspected, and keyboard filter removal restores retained
runs. React Doctor 0.9.14 changed-scope scans report no diagnostics (100/100);
this is not a full-app cleanup baseline. Parent/child navigation and family read
projections, native publication/root acceptance and all earlier remaining gates
are still unfinished.

The existing run-detail snapshot now adds bounded native family links through a
tenant-bound read-only definer: accepted parent/root IDs and at most 64 immediate
admitted children with current statuses, no callable input/result values. Retained
checkpoints do not call the unregistered native function. The same authorized
API use case forwards this optional projection; the existing detail page renders
child/parent/root links without an additional query, store or event subscription.
An owned actual API-role matrix proves parent/child links and rejects no-scope,
wrong-workspace and direct family-table reads. The full SQL remains unregistered,
OFF, with no permanent serving grants. Six run-history Chromium journeys pass,
including 390px keyboard child→parent navigation; the rendered child page was
inspected. Native authoring/publication/root, artifact/retention, permanent
runtime/readiness/privilege and full concurrent/restart/process gates remain open.

Native authoring transport now preserves explicit Graph V2 drafts and published
Graph2/checksum-V3 records through the normal database readers and API serializers.
The separate `draft-v2` strong ETag authenticates the full declaration, selector,
exact Call pin and editor representation; retained `draft-v1` identity and Graph
V1 parsing remain unchanged. Public draft/version schemas reject cross-format
pairs, and generated client/OpenAPI schemas retain recursive callable descriptor
structure rather than an unconstrained transform projection. Bounded descriptor
admission remains the runtime authority. The existing save owner preserves its
authorization, compatibility/placement lock, revision/ETag CAS and audit path.
An owned actual API-role create→native save→read flow rejects the stale retained
tag, changes the native tag with its selector, and leaves an already published
native version unchanged. This proof explicitly prepares only the disposable
draft schema and bootstraps publication/root; it is not normal native publication,
HTTP/browser authoring, permanent migration/readiness or positive writer proof.
The unregistered SQL SHA256 remains `80b339addd08c335cf99ae31bee205e6fc859ce8ebb0ee11cc8b11196f553de7`,
OFF with no permanent serving grants. Existing native publication/root, editor,
artifact/retention, raw nonliteral writer trust and full qualification gates remain
open. The repository complexity gate additionally reports owned F08 execution
hotspots; no waiver or full closure is claimed from passing this authoring slice.

Primary selected purpose-separated process semantic HMAC capability direction
for the unresolved ordinary-database-login native writer forgery fence and release
owner allocated ADR066. [ADR066](../adr/066-native-workflow-semantic-attestations.md)
and its [concrete contract](08-native-semantic-attestation-contract-proposal.md)
were accepted at exact a6f555d0 after primary full read and two independent
reviews. Bounded implementation and owned-local disposable qualification are
authorized; registration, permanent activation, real key provisioning and
deployment remain separately gated.
No key, extension, environment configuration or positive grant is provisioned.
An owned read-only PG18.6 probe found pgcrypto available but uninstalled; availability
is not readiness or authorization to install. New writers remain OFF, and accepted
native continuation needs a currently permitted compatible signer rather than a
historical token dependency under the accepted contract. This records a decision, not
completion of any F08 acceptance row.

The initial ADR066 private byte-framing codec distinguishes absence/empty fields,
uses ordered count/tag/uint32-BE-length/exact-UTF8 framing, rejects PostgreSQL
unrepresentable text and checks bounded aggregate allocation. It has no key,
signer, verifier, database access or public package export. Eleven focused tests
and an owned network-none/no-port PG18.6 fixture qualify 48 Node/PostgreSQL framing
and standard HMAC differential vectors, including changed-MAC digest rejection.
Fixture pgcrypto was installed only in its private disposable schema and removed
with the database; no serving grant or persistent key was created. This does not
qualify owner-specific signed field lists, timing resistance, raw-writer fences,
readiness, rotation, early seals or full F08 behavior. Native writers remain OFF.

The existing ordinary native physical-completion owner now records first-write
inline value bytes/checksum/length with actual lease/fence/canonical delivery,
before its existing physical output/event/receipt writes. Retained completion and
native Call input-alias completion do not use this output ingress; duplicates do
not create another provenance row. The OFF SQL draft adds the protected ingress,
ordinary native attempt writer fence and deferred actual completion/event/receipt
seal. Owned actual worker-role flow qualifies checksum/worker/fence/delivery and
unsealed rollback denials, raw first-output update/successful-attempt insertion
denials, and four mutations after an early seal fired in the actual completion
owner. Four ordinary outputs retain their first byte identity in that fixture;
Call input aliases have no output reservation. Attempt reparenting is separately
denied by the existing worker column grant, not counted as a triggered fence.
The full unregistered draft is now a38422af (36 functions, zero permanent serving
EXECUTE, writes OFF, registered head0135/count133). This does not close artifact,
semantic result/publication capability, native cohort/readiness or full F08 gates.

Callable physical-source hydration now uses two narrow protected reads: bounded
current-success metadata excludes actual pinned Call sites before value loading,
including the pre-admission input-alias window; 16-attempt pages return protected
original inline bytes/checksum/length bound to the actual accepted version,
current attempt/fence and both physical refs. Existing snapshot verification
checks byte integrity/projection agreement before using original parsed values.
Ambiguity still belongs to the engine and requires no value hydration. Owned
worker node-output and expression/just-terminal nested-Call fixtures qualify these
reads and scope/bounds denials without a broader protected-table grant. Earlier
fixture failures exposed the pre-journal Call alias and direct-table privilege
gaps; both were fixed through the existing protected ownership seam, not by
relaxing source assertions or granting table access. The full OFF/unregistered
SQL draft is now 1da1694f (38 functions; permanent serving EXECUTE remains zero).
This is source-byte hydration evidence, not semantic attestation or artifact,
normal native publication/root, readiness/rotation/restore or full F08 closure.
