# F08 — Durable workflow-call contract proposal

Status: **PROPOSED; not an accepted ADR or persistent implementation authority.**
Primary selected strict independent occupancy/fail-fast child admission on
2026-10-02. Primary also selected the same-workspace pins, portable closed-object
descriptors, proposed expansion bounds, configuration-only preview, conservative
membership-revision authority and publication-pinned family deadline directions.
The complete ADR, transaction/privilege contract and review closure still require
acceptance before persistent code. Baseline: accepted F07
`e7d25e1f85342f10ae0044aadd408d88c49ea993`, tree
`f3a07aea3819c384928dea7dfd7394553ce4aad3`.
Parent: [F08](08-subworkflows.md). Decision text:
[ADR065 draft](../adr/065-durable-parent-child-workflow-calls.md), globally reserved
by the release owner on 2026-10-02; number allocation is not acceptance.

## Product contract and selected occupancy

One same-workspace published workflow invokes an exact published callable version,
waits durably, then receives its bounded typed result. A child is a separate run,
not a copied graph, For Each body, provider HTTP call or recursive worker executor.
V1 excludes fire-and-forget, cross-workspace calls, recursion and dependency import
bundles. A callable child initially uses the existing Manual entry contract; no
second trigger-entry framework or changing ordinary `run_input` semantics.

A waiting parent releases its worker job/lease, **not its workspace or workflow
active slot**. Each child consumes ordinary independent active occupancy and its
child workflow's current cap. Committed reservations count exactly once; they are
not extra capacity. Root admission and ordinary queued overflow stay unchanged.

At one logical call, atomically accept the child **and** obtain an ordinary active
reservation with the existing entitlement, queue-cap and workflow FIFO checks.
If this cannot be done, retain a definite call refusal with **zero accepted child
runs**, no reservation and no child execution outbox. Never leave an unreserved
queued child waiting behind its own parent. Normal fair outbox delivery still
governs when reserved child work reaches workers; reservation is not a start-time
promise or a worker/global-capacity exemption.

Consequences must be visible next to Call Workflow configuration and on failure:

- Workspace cap one cannot execute a nested call because parent and child would
  require two slots. The call fails explicitly; it does not wait for itself.
- Any fully occupied workspace can refuse a child even when its cap exceeds one.
- A full child-workflow cap, an earlier eligible FIFO ticket, a full queued cap,
  or unavailable/suspended current entitlement can also refuse a fresh child.
- A committed child reservation survives a later limit reduction under ADR058;
  its start still follows the existing first-transition order checks.
- No control-path cancellation or deadline delivery needs a new slot, and those
  exemptions never authorize provider/node execution.

Capacity refusal is an ordinary definite Call Workflow node failure with proposed
safe code `workflow.child_capacity_unavailable`, not a provider failure, unknown
effect or transient promise of eventual execution. Existing unhandled-failure
semantics make the parent failed. F09 custom failure routing is not implemented
by F08. V1 has no automatic Call Workflow retry or new child after refusal. An
explicit parent replay is a new execution and may repeat earlier parent effects;
existing replay authority/confirmation and immutable-history rules apply.

## Callable contract, pins and bounded expansion

Recommend a versioned callable declaration stored in the immutable authoring and
executable projections: a bounded portable input schema, bounded result schema,
and one explicit result selector. Validate the input before child admission and
the selected result before a callable run may succeed. Missing/skipped selector
output or invalid result is a definite child failure, not implicit null, the last
node output, or concatenation of every output.

Use existing bounded JSON values and schema-document projection owners, but do
not mistake `schemaDocumentSchema`'s JSON-object check for a runtime validator.
V1 recommends a versioned portable type descriptor for string, finite number,
integer, boolean, null, bounded array and closed object. Input and result roots
are closed objects, defaulting in the editor to explicit empty object contracts.
An object declares `properties` and a unique `required` subset; undeclared fields
are always rejected. Property names match `[A-Za-z_][A-Za-z0-9_]{0,63}`, excluding
`__proto__`, `prototype` and `constructor`. An array declares its item type and
`maxItems` in 1–1,000, with editor default 1,000. Schema depth is at most 8, total
type descriptors at most 256, and properties per object at most 128. These are
proposed hard platform bounds, independent of existing node-value byte/depth/member
bounds. No unions, references, patterns, code, default insertion, coercion or
remote resolution. The existing SDK projection renders the corresponding
browser-safe JSON schema; the workflow-model callable contract owns bounded
runtime validation, not an arbitrary JSON-schema evaluator. Existing restricted
value-source policies own result mapping; no new expression evaluator.

Call node config pins workspace-local workflow ID, exact version ID, checksum and
callable-contract identity. Publication verifies that they agree, the child is
callable and executable, and the current editor may use it. Changing any pin,
callable schema or selector changes executable identity. An Upgrade action edits
the draft explicitly; republishing a child never changes a parent's retained pin.
Version rows hold the graph once. Dependency relations are verified derived
indexes of immutable pins, never competing graph or callable-contract truth.

Recommend initial hard platform bounds of four child edges deep, 64 child runs
per root execution, and 1,000 expanded node invocations across the complete pinned
family. These are proposal values, not current accepted quotas. Count repeated
call sites and For Each products, not only distinct child versions. Reject any
ancestor workflow identity repeated on a call path, even at another version;
shared sibling dependencies remain legal. Validate the complete immutable closure
before publication, with bounded work and safe over-limit rejection. Runtime
records enforce the accepted worst-case budget monotonically; duplicate spawn
never consumes it twice. Do not truncate, refund/recalculate from Redis, or
silently increase existing loop/attempt limits.

New graph/executable/checkpoint formats are required where existing strict
contracts cannot express the declaration and call wait. Retain every current
graph/checksum and checkpoint parser; choose exact new format/policy versions in
the accepted ADR/catalog inventory, not by mutating V1/V2 semantics in place.

## Existing interfaces and the small extension

Keep `CoordinatorRunStore.loadAdvanceState` and `commitAdvancePlan` as the worker's
durable seam. Extend their bounded facts and the pure engine transition plan;
do not add a generic family scheduler, separate history store or public child
acceptance endpoint. The normal Call Workflow declaration attempt validates input
without provider I/O; the coordinator consumes that bounded declaration and
enters a dedicated call-control wait, analogous to the existing For Each control.
It never holds a worker while waiting for a child.

Proposed private plan/fact vocabulary (not code or an approved wire schema):

```ts
type ChildAdmissionIntent = {
  invocationKey: string;
  childWorkflowVersionId: string;
  inputReference: BoundedOutputReference;
  inheritedDeadlineAt: string;
};
type ChildAdmissionFact =
  | { kind: 'admitted'; invocationKey: string; childRunId: string }
  | { kind: 'refused'; invocationKey: string; reason: SafeCallRefusal };
type ChildTerminalFact = {
  invocationKey: string;
  childRunId: string;
  status: TerminalRunStatus;
  resultReference?: BoundedOutputReference;
};
```

All identity, byte, length and cardinality bounds come from accepted shared
contracts. Input/result references are scoped, checksum-bound and owned by
existing output/artifact persistence. New lineage is scoped by workspace, parent
run and the existing full branch/iteration invocation key. One durable call
record contains immutable request identity and either one child ID or one
definite refusal. Its unique key is not a 24-hour request receipt. Resolve a
recorded result before current capacity checks; mismatch is corruption/conflict,
not permission to allocate another child. Ordinary request/inbox receipts remain
with their existing owners and cannot replace call identity after expiry.

## Atomic spawn, FIFO and lock contract

Extend the canonical coordinator transaction and existing `acceptWorkflowRun`
implementation, including ordinary queued-run insertion, pinned entitlement,
initial checkpoint/event/outbox, current compatibility and failure-notification
policy. Expose no general worker bypass of the dispatcher reservation helper.
Today acceptance takes `WorkspaceTransaction` and the coordinator takes the
already checked-out `PoolClient`. The proposed concrete internal adapter is
`workspaceTransactionFromClient(client: PoolClient, workspaceId: WorkspaceId):
WorkspaceTransaction` in `tenant-access/workspace.ts`: construct
`drizzle(client, { schema: databaseSchema })` and freeze `{ db, workspaceId }`,
exactly as `withWorkspaceTransaction` already does. Both callers reuse this
factory. It does not acquire/release a client, begin/commit/rollback, change scope,
or outlive the owning `withTenantScopedClient` callback. Coordinator transaction
hygiene, cancellation, protocol and workspace-first lock remain the outer owner.
Call existing `acceptWorkflowRun` on that adapter, extending its strict internal
input for a `workflow_call` trigger and immutable lineage; do not duplicate SQL
or introduce another admission protocol. Manual is the child's graph entry node,
**not** its persisted trigger type: do not impersonate an API manual start or
bypass the existing checked-manual-start fence.

Propose worker-only, tenant-bound
`app.lock_workflow_call_admission(parent_run_id uuid, expected_revision integer,
invocation_key text, candidate_run_id uuid)`. Canonical acceptance allocates the
candidate ID with its existing ID owner and passes it with the strict internal
child context (parent ID/revision/invocation), never caller-supplied actor or
arbitrary root identity. The coordinator prelocks the ordered prerequisites below;
the helper verifies/reuses them and refuses any unbound insertion. It resolves the retained call site/root authority and
immutable bounded lineage from durable pins, validates them, and binds only that
candidate child insertion/reservation. Add no general reservation-helper grant
to worker. Any security-definer helper has fixed search path, tenant/identity
checks, owner-defined SQL, PUBLIC/other-role revocation and only worker EXECUTE;
no arbitrary identity-table SELECT/UPDATE grant. SQL writer/commit fences must
reject a `workflow_call` child without its exact parent CAS/call record and
ordinary reservation, including a direct worker insert or an old writer. The
canonical acceptance module remains the row/event/checkpoint/outbox owner; the
proof helper is narrow enforcement, not a second acceptance implementation.
After canonical acceptance has created its outbox, the equally narrow worker-only
`app.reserve_workflow_call_active_admission(parent_run_id uuid,
expected_revision integer, invocation_key text, candidate_run_id uuid,
outbox_event_id uuid)` revalidates that exact durable call proof, pin/input and
new child/outbox identity and delegates to the existing
`reserve_workflow_run_active_admission` implementation. It creates no alternative
capacity/FIFO calculation. It may operate only on the new candidate bound to the
still-held parent CAS; identity/protocol mismatch throws, a definite canonical
capacity/FIFO refusal returns false. Its tenant/role/definer restrictions match
the proof helper; worker cannot call the unrestricted dispatcher helper directly.
The exact-call fast path loads and verifies the already recorded identity/fact
first and performs only the existing parent CAS/receipt continuation; it does not
invoke fresh-admission authority/active-policy checks. A record appearing during
fresh admission is rechecked under the immediate-parent CAS and converges on that
same record. Reading an inactive actor row for lock ordering is not reauthorizing
or rejecting an already accepted/refused call.
A narrowly scoped internal child path must bind its parent CAS, exact published
call site/input and root admission authority before requesting the same canonical
reservation checks. Persist the call record, parent call-control checkpoint CAS,
child acceptance/reservation and events/outboxes in one outer transaction.

Every candidate acceptance operation runs within the savepoint, not just reserve.
If the speculative child is authoritatively refused, a savepoint rolls back **all** candidate
child acceptance rows, claim, initial event/checkpoint/outbox and reservation;
ticket sequence gaps are allowed. The outer parent CAS commits only the one
refusal fact and parent continuation. The pure engine consumes that fact and
derives node/run failure on the next advance; SQL does not independently derive
aggregate run status. A crash between refusal and consumption recovers the same
fact, never attempts fresh admission. Losing parent CAS rolls back both admitted
and refused branches and reloads/recomputes.

Only definite, locked/authoritatively observed business-policy outcomes become
immutable refusal facts. Proposed safe classifications are:

| Observed outcome | Durable call outcome |
| --- | --- |
| Workspace/child workflow active slot unavailable or earlier eligible FIFO ticket | `workflow.child_capacity_unavailable` |
| Ordinary queued limit reached | `workflow.child_queue_unavailable` |
| Current entitlement absent, suspended, expired or not yet effective | `workflow.child_entitlement_unavailable` |
| Initiating actor/membership inactive, revision changed or `run:start` lost | `workflow.child_authority_unavailable` |
| Workspace inactive, child archived or current region admission denied | `workflow.child_admission_unavailable` |
| A supported compatible artifact authoritatively reports the pinned child no longer admissible | `workflow.child_compatibility_unavailable` |

All refusals converge on the same logical call record and ordinary required-node
failure, with zero child rows/reservations/outboxes after savepoint rollback.
Invalid typed input is rejected by the declaration's existing durable node-failure
fact before a child intent exists, with no automatic Call Workflow attempt retry.
Ancestor cancellation/deadline yields authoritative control observations and
normal cancellation/deadline precedence, **not** a misleading capacity refusal.
Exact recorded admitted/refused calls are resolved before current policy checks.

Connection loss, statement/lock timeout, deadlock, missing required counter/pin/
artifact, malformed facts, identity conflict, unsupported writer protocol or
compatibility artifact, and unexpected SQL/transport errors roll back the entire
outer transaction for existing recovery; they never become definite refusal.
A SQLSTATE alone is insufficient: for example `PTA01` covers both entitlement
denial and broken required admission state. Classify only an explicit typed
policy result proven under the relevant locks. After uncertain COMMIT, reconnect
and resolve the same durable call/CAS identity before doing anything new; do not
infer zero children from a socket failure. No new retry scheduler is introduced.

Proposed acquisition order for the new child-bearing coordinator path:

1. Shared workspace lifecycle/admission lock; current user/membership authority
   where applicable; current compatibility release.
2. Target workflow lifecycle/version, failure-notification policy/destination and
   notification connection locks, then current entitlement pointer/version,
   **before** run/checkpoint/counter locks. Multiple target workflows use stable
   workflow-ID order. Do not prelock concurrency-policy rows: their update owner
   acquires the counter first; eligibility reads those rows under the same counter.
3. Verify the immutable lineage (at most four edges), then lock ancestor run rows
   `FOR SHARE`, individually root-to-immediate-parent, excluding the immediate
   parent. Lock that parent run/checkpoint directly `NO KEY UPDATE`, never SHARE
   followed by a lock upgrade. For a root calling directly, there are no separate
   ancestor locks. Revalidate every lineage edge/root identity, expected revision,
   executable/invocation, all ancestor cancellation and PostgreSQL-clock deadlines;
   serialize the call record. A mismatched/missing lineage is corruption, not a
   caller-selected chain or a policy refusal.
4. Workspace admission counter; candidate **new** child rows and outbox; ordinary
   ticket/FIFO eligibility and reservation insertion. The child rows belong to
   this transaction, so their FK locks cannot wait on another child owner.
5. Parent checkpoint/events/facts/outboxes and receipt completion; commit.

Do not look up/lock an already accepted child's run behind the counter: exact
record replay does not reacquire its reservation. Dispatcher retains its current
workspace/run key-share-before-counter order. Existing reservation recovery does
not take the counter or lock a parent. Child terminalization writes its own
terminal truth and a parent identifier-only wakeup in the same transaction; it
**never** locks parent run/checkpoint while holding the child. The parent later
loads the immutable terminal fact through its existing advance seam. Cancellation
propagation similarly emits bounded control intents instead of locking a whole
family while holding one run.

Ancestor locks are the cancellation linearization fence, not a family scheduler.
Cancellation of any ancestor/subtree takes UPDATE on its selected run, so either
spawn commits first and that child is admitted work requiring cancellation, or
cancel commits first and the blocked spawn rereads it and accepts no child.
Hold the lineage locks through outer COMMIT. Never acquire an ancestor while
holding a descendant run/counter; one advance cannot both spawn and terminalize
the same immediate parent. Deadline timestamps are immutable; recheck the clock
just before insertion/reservation. Deadline-marking updates serialize on the same
ancestor locks; expiry does not depend on a delayed control message. An admission
whose final clock check precedes expiry can commit as accepted and is canceled/
timed out normally, never retroactively erased. Control outboxes still propagate
to already admitted children without multi-run update locks.

Opposing-path reconciliation against the current baseline:

| Existing owner | Current order / required preservation |
| --- | --- |
| API manual/root acceptance (`0131`, `execution-acceptance.ts`) | workspace → actor/membership → command identity → canonical admission; acceptance notification and entitlement locks precede insertion/counter. Child uses a distinct narrow proof, not manual-writer impersonation. |
| Membership commands (`identity-workspace-member-command.ts`) | workspace UPDATE → users in identifier order UPDATE → memberships → command receipt. Child workspace SHARE serializes ahead of those changes; do not acquire workspace after actor/membership. Invitation rejoin retains its workspace/user/membership order and increments the removed membership revision. |
| Compatibility selection/activation (`0019:179–217,400–424`) | serving selector locks current pointer/release SHARE before workflow/run; activation locks that pointer UPDATE and approval/release, not tenant run/counter locks. New retirement dependency inventory must remain read-only/bounded rather than acquiring run locks behind the pointer. |
| Publication (`workflow-publication.ts`) | workspace/actor/membership → compatibility → workflow/draft UPDATE; no existing-run lock. New dependency publication reads a bounded tentative pin set, locks all involved mutable workflow rows (own row included) in stable order before its draft, then rereads/verifies draft revision/pins; a change retries/conflicts instead of acquiring a new lower-order lock. It never locks runs/counter. Immutable closure pins are not copied or independently mutated. |
| Concurrency control (`0127:328–375`) | workspace/authority → workflow SHARE → receipt → entitlement SHARE → counter → concurrency-policy update. No concurrency-policy lock before counter in child path. |
| Notification/connection policy (`0088:415–440`, `0128:307–317`) | acceptance locks policy/destination then connection before run/counter; existing terminal notification intents use pinned references/FK key-share, not current policy locking. Preserve that separation. |
| Dispatcher/reservation (`0127:267–302`) | workspace/run KEY SHARE before counter; never ancestor SHARE or run UPDATE behind counter. Ancestor SHARE and parent NO KEY UPDATE are compatible with those FK locks. |
| Ordinary coordinator terminal/control (`coordinator-run-store-commit-state.ts`, run transition) | workspace → its own run/checkpoint NO KEY UPDATE → node/attempt facts → counter/FK writes. No ancestor/child UPDATE or current target-policy lock from a terminal producer; new child terminal wakeup uses parent identifier only. |
| API cancellation (`workflow-run-cancellation.ts`) | workspace → selected run UPDATE → cancel fact. It does not lock descendants; the new root-to-parent SHARE fence blocks only the selected ancestor. |
| Lifecycle/retention/purge (`workflow-authoring-lifecycle.ts`, `0080`, workspace control ledger) | workspace/control ledger before workflow/run/artifact deletion locks. Workspace exclusive destruction prevents overlap with the coordinator's workspace SHARE; ordinary workflow archive UPDATE serializes against target workflow SHARE without run/counter locks. Do not acquire workspace behind lineage/counter. |
| Reservation recovery (`0127`, current recovery helper) | reservation/outbox rebind only, no counter/parent/ancestor; exact existing child replay never re-reserves. |

This is a proposed lock contract, not executable proof. Independent reconciliation
and real blocker/race tests must close every path before SQL, including root and
intermediate-subtree cancellation winning/losing admission, lineage bounds,
multiple sibling declarations, policy changes and dispatcher/counter contention.
Deadlock retries are not its justification.

## Authority, lifecycle and preview

Publishing a call requires current workflow-publication authority and readable,
same-workspace executable child pins; pinning grants no later authority. Fresh
child acceptance checks active workspace and child lifecycle, current compatible
admission, regional admission, current entitlement, queue cap and workflow/FIFO
rules. An archived child denies new spawn; an already accepted child settles and
its exact admission result remains recoverable. Parent archive is not cancellation
of the accepted parent. Workspace deletion prevents new children and drains both
parent and children through existing lifecycle owners.

Recommend durable root initiation authority rather than inferring identity from
an idempotency scope or using the child's publisher. Human manual/API/replay
parents carry their actual initiating actor and membership role revision at root
acceptance. Fresh children require the same revision, active actor/membership and
`run:start`; any authority revision change (including promotion, removal/rejoin
or suspension/restoration) refuses a future child without retroactively canceling
an already accepted child. Original session expiry alone is not revocation of
durable work. Explicit root replay authorizes a new current context. Automated
schedule/webhook parents carry a workspace-owned admitted-trigger authority,
not a fabricated human actor or publisher session. Pausing the trigger does not
cancel its already accepted root; current child lifecycle/security gates remain.
The exact durable authority shape and bounded revocation behavior require ADR
acceptance; existing workflow-run rows do not contain an initiating principal.
Revision pinning deliberately rejects even a promotion that still grants
`run:start`; primary selected this conservative product tradeoff separately from
capacity. Current role changes increment only when changed; removal/leave,
membership suspend/reactivate, ownership transfer and removed-member invitation
rejoin increment `role_revision` in their existing owners. This does not assert a
new user-global or workspace suspension generation: those current status checks
deny while inactive, and only implemented membership revisions remain pinned.

Connections remain the child's own pinned workflow references and existing
credential-resolution/revocation policy; no inherited parent credential map,
raw secret in input, or child publisher's credential authority. Lineage/history
reads use existing `run:read` and workflow-name disclosure rules; inaccessible
links reveal no workflow name or private execution input/result.

V1 node preview validates call config/input/pins only and explicitly reports
that durable child execution is unavailable in preview. It does not secretly
accept production children, consume another person's quota or emulate success.
Whole-family execution previews require their own approved isolation/accounting
design and are not delivered by F08.

## Deadline, cancellation and outcome precedence

Pin a one-hour effective default upper bound in the **new executable family
policy at publication and the root's accepted immutable policy**, reduced by
the caller's deadline or configured workflow duration; this introduces no default
change for retained non-call workflows or an ambient fallback on recovered runs.
Each child deadline is the minimum of the
parent's absolute deadline and its own configured duration at acceptance, so
queue/wait time consumes the budget and a child can never extend its parent.
Recheck the PostgreSQL clock inside admission, not a worker timer.

Parent cancellation prevents unaccepted calls and durably requests cancellation
of admitted children. Child cancellation is an ordinary cancelable run action;
it settles the parent's call as a non-success. Cancel/deadline controls work at
full capacity and recover after Redis/process loss. No fresh sibling/deeper call
is admitted once the root/parent cancellation or deadline is observed.

Preserve ADR007's truth: unresolved possibly completed child effects make the
call and parent `outcome_unknown`, ahead of cancellation, timeout and failure.
Otherwise parent cancellation wins, then parent deadline, then a required child
failure/non-success; success requires a validated child result. Do not mark a
parent finally canceled/timed-out before admitted child effects are terminal or
truthfully reconciled. A completed child remains immutable when cancellation
races it. A child timeout is a definite call failure unless the parent's own
deadline has expired; its detail stays visible without inventing another status.
An unknown child is never automatically spawned again, retried as a new run or
rewritten to canceled. User replay creates a new parent and new child identities.

## Retention, compatibility and delivery gates

Retain immutable transitive child-version pins while referenced by active
publications, admitted/nonterminal families, replay-eligible history or legal
hold. Existing compatibility retirement inventory/query must include those
dependencies. Child call/result/terminal facts and referenced artifacts cannot
be reaped while a nonterminal parent still needs them, even when ordinary child
detail expiry has elapsed. Charge artifacts once through their existing owner;
references extend retention, not free capacity. Normal expiry after dependencies
end is bounded and resumable; legal hold prevents destruction, never execution.

Child/run lineage follows existing summary/detail retention and workspace purge
owners. A held child or parent retains the evidence required to interpret the
link and pinned version. Do not use cascades that erase live/held evidence or an
indefinite retention cycle; document the dependency-aware purge order and indexed
bounded maintenance queries before schema. Historical links can later show
unavailable detail without fabricating a result or starting another child.

Keep new placement/publication and root-family admission off until schema,
compatible readers/executors, reservation enforcement and live gates pass. OFF
blocks new F08 roots/publications but keeps compatible accepted-family execution
and accepted-child settlement; existing bounded continuations remain subject to
current lifecycle/authority/entitlement checks. Old serving artifacts must fail
closed on new call formats and SQL writes, not claim unsupported child work and
exhaust its transport retries. Prove preactivation and already-running old writer
barriers; a UI flag or startup check alone is insufficient. Rollback retains
the enforcing compatible artifacts until accepted families drain; no down
migration, old-format rewrite or subtractive executor rollout is implied.

Required evidence: model/schema/pin/cycle/bound tests; real PG duplicate spawn,
CAS rollback, queue/workflow/FIFO/cap-one/full-cap races, lifecycle/member/compat
revocation, cancellation/unknown precedence and held retention; actual worker
death before/after spawn and settlement, Redis loss, duplicate wakeup and one
parent resume; real ordinary UI/API/worker typed call, explicit pin upgrade,
links/result/failure/cancel and access loss; old-image/OFF/retained-version proof;
source-bound required owned CI, coverage and separate design/implementation review.

## Exact current-source anchors

- [ADR012](../adr/012-fair-admission-backpressure-entitlements.md):16–31,
  [ADR058](../adr/058-workflow-concurrency-queue-admission.md):24–57 and
  [ADR057](../adr/057-workspace-usage-capacity-and-retained-activity.md):15–29:
  waiting occupancy, independent capacity and reservation/FIFO semantics.
- [Concurrency SQL](../../packages/database/migrations/0127_workflow_concurrency.sql):67–103,
  211–302 and [lock contract](../operations/workflow-concurrency-enforcement.md):9–54:
  authoritative predicates, counter serialization and non-inverting FK locks.
- [Graph](../../packages/workflow-model/src/graph-contract.ts):45–71 and
  [limits](../../packages/workflow-model/src/graph/validation-contract.ts):15–22:
  only For Each structure today; expanded work is bounded to 1,000 per graph.
- [Executable](../../packages/workflow-engine/src/compilation/executable-foundation.ts):80–99,
  [ADR002](../adr/002-postgresql-jsonb-drafts-immutable-versions-checksum-identity.md):49–74 and
  [ADR010](../adr/010-node-executor-compatibility-retirement.md):55–108,213–253:
  immutable pinned execution and compatible retirement dependencies.
- [Coordinator](../../apps/worker/src/execution/coordinator-handler.ts):104–149,
  [commit](../../packages/database/src/execution/coordinator/coordinator-run-store-commit.ts):85–166 and
  [transactions](../../packages/database/src/execution/coordinator/coordinator-run-store-transactions.ts):34–44:
  pinned version, pure decision, existing CAS/outbox seam and workspace-first locks.
- [Checkpoint](../../packages/workflow-engine/src/checkpoint/checkpoint-v1.ts):257–267 and
  [persisted parser](../../packages/database/src/compatibility/persisted-workflow-checkpoint.ts):43–60:
  current waits have timed/loop semantics, not child identity.
- [Acceptance](../../packages/database/src/execution/runs/execution-acceptance.ts):27–44,277–430 and
  [run schema](../../packages/database/src/schema/execution.ts):18–79:
  existing acceptance owner, five trigger types and no durable initiating principal.
- [Transaction adapter](../../packages/database/src/tenant-access/workspace.ts),
  [member commands](../../packages/database/src/tenant-access/identity-workspace-member-command.ts),
  [membership lifecycle](../../packages/database/src/tenant-access/identity-workspace-membership-lifecycle.ts),
  [invitation rejoin](../../packages/database/src/tenant-access/identity-workspace-invitation-acceptance-store.ts):548–557:
  one checked-out client, workspace-first authority and actual revision transitions.
- [Cancellation](../../packages/database/src/execution/runs/workflow-run-cancellation.ts):41–44
  and [manual fence](../../packages/database/migrations/0131_checked_manual_start.sql):43–98:
  selected-run UPDATE and API-only manual trigger enforcement, not child admission.
- [Run contract](../../packages/contracts/src/http/workflow-runs.ts):39–45,114–154:
  strict existing trigger/summary wire; no child lineage yet.
- [ADR007](../adr/007-run-node-state-retry-idempotency.md):36–43,156–180,
  [ADR034](../adr/034-workflow-archive-restore-and-activation.md):46–55,
  [ADR042](../adr/042-workspace-member-removal.md):70–75 and
  [ADR013](../adr/013-retention-workspace-deletion-legal-hold.md):44–80:
  terminal truth, archived admission, removed-member continuation and held purge.

No migration number, schema relation or runtime flag is allocated/implemented by
this proposal. ADR065 is reserved for the draft only. Release owner allocates the
additive migration and authoritative integration base before persistent work.
