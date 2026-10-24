# F08 — Reusable subworkflows after the architecture reset

F45 amendment (2026-10-21): F45 adds explicit ordinary file pages as a source for outer/inner loops. The shared loop/expanded-step budgets, slot handoff, checkpoint and capacity limits are unchanged; large datasets need page-level bulk work or separate runs. See the [approved F45 plan](45-bigger-files-and-paged-data.md) for delivery and qualification; older limit descriptions below record the original slices.

Status: accepted by the owner on 2026-10-10; slices 1–4 implement and qualify
finished-loop pruning, callable contracts, durable Calls, controls and history.
Slice 5 was authorized on 2026-10-17; its measured limit decision is recorded below. This document
replaces the former F08 outline; it does not restore the
reverted implementation. [ADR 070](../adr/070-workflow-call-boundaries.md)
records the accepted decisions. [Architecture](../architecture.md) and
[ADR 069](../adr/069-architecture-reset.md) describe the current foundation.

## Outcome and scope

A published workflow calls an exact published child in the same workspace, waits
durably for its typed result, and exposes parent/child history. A waiting parent
releases its worker job. The child is an ordinary independent run. First
delivery supports bounded inline JSON inputs/results, one result selector, and
wait-for-result calls through existing Manual/Webhook JSON entries.
Schedule-entry calls need a later explicit contract. Intermediate child
artifacts keep their current owners; sharing artifact-valued call inputs/results
needs later explicit design.

No recursion, cross-workspace calls, fire-and-forget, portable dependency
bundles, extract-selection UI, recursive in-process executor or self-HTTP calls
in this delivery. Extend the existing graph, executable and checkpoint shapes
without numbered replacements, legacy readers, release cohorts or feature-switch
protocols.

Accepted terms: a **callable workflow** declares an input/result contract; a
**workflow call** is one scoped Call Workflow invocation; its **child run** is
one separate accepted execution. A run can be both a child and a parent. A
nested For Each body remains part of one run. Add these terms to the live glossary with their implementation slice; the
glossary is not an implementation specification.

## What changed since the reverted attempt

The pure engine owns transition rules. `execution.advanceRun` verifies the
persisted workflow projection and supplies the engine decision to the database
advance callback. Database stores own transactions, checkpoint CAS, receipts,
admission, events and outbox. The worker owns dispatch/executors and lifecycle.
There is one stored shape per thing, one serving catalog, three database roles
and no compatibility-release/control-ledger infrastructure to extend.

Inspected current seams:

- `packages/workflow-model/src/graph/` and `/server`: graph, portability,
  expression and authoring validation.
- `packages/workflow-engine/src/transition/` and `checkpoint/`: pure decisions,
  loop state and completed-output references.
- `packages/execution/src/runs/advance.ts`, `initial-checkpoint.ts` and
  `attempts/load-inputs.ts`: orchestration and input projection.
- `packages/database/src/runs/commands/acceptance.ts`, `advance/store.ts`,
  `advance/persist/` and `outbox/`: run/receipt persistence and transport.
- `packages/database/migrations/0000_baseline.sql`: existing reservation,
  concurrency and admission-counter functions.
- `apps/worker/src/runs/`, `attempts/`, `outbox/`; API workflow authoring/runs;
  web editor, publishing, versions and run-history features.

The source review includes current F08, ADR 020, ADR 069 and the reset tracker;
reverted ADR 065, the contract proposal and glossary at `02b82ea8b^`; and the
[149](https://github.com/vigani1/pertexo/pull/149),
[159](https://github.com/vigani1/pertexo/pull/159) and
[162](https://github.com/vigani1/pertexo/pull/162) descriptions. Historical
sources explain requirements and cost; their code, SQL fences and framing are
not a base.

## Ownership

| Owner                     | Work                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| workflow-model            | Callable declaration, bounded input/result type contract, Call Workflow config/pins and semantic validation                  |
| workflow-engine           | Pure call declaration/wait/completion/refusal/control decisions and checkpoint pruning                                       |
| execution                 | Child acceptance/completion/cancellation as run actions, input/result projection and existing advance orchestration          |
| database                  | Typed call relations, stable spawn identity, transactions, CAS, ordinary acceptance/reservation, events/outbox and retention |
| worker                    | Execute actions, dispatch ordinary child jobs and resume parents from durable terminal facts                                 |
| nodes-core / node-catalog | Thin SDK/catalog adapter for the model-owned logical Call node; ordinary node/config identities                              |
| contracts / API           | Authoring and safe run lineage/result DTOs, current permission checks and errors                                             |
| web                       | Callable contract editor, exact-version picker/upgrade, mappings, waiting/refusal states and parent/child links              |

The model keeps its existing JSONata/Zod dependency direction. A thin adapter in
nodes-core consumes the model contract; the model does not import the SDK,
catalog, database or worker. Keep the public execution door and database area
doors. Create only the files needed by each slice.

## Accepted decisions

| Question                      | Recommendation and consequence                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version pin                   | Publish against one immutable child version and its existing executable identity. Resolve its callable contract once at publication. A newer child publication never changes a retained parent pin; Upgrade is an explicit draft edit.                                                                                                                                                                  |
| Authorization                 | Publication requires current authoring/read authority for both the parent and same-workspace target. Starting the parent requires current `run:start`. Subsequent calls are actions of that accepted execution, not an impersonated new user request or session-dependent continuation. New starts/publications after access revocation are denied; accepted runs retain normal continuation semantics. |
| Deadline                      | Inherit the parent's absolute deadline when present, preserving current absence/default semantics. A configured shorter child deadline may narrow it and is recorded once with the intent. Never extend or reset it on retry. Ordinary deadline controls remain dispatchable without a new active slot.                                                                                                 |
| Usage                         | Attribute normal child run/attempt/provider activity to the same workspace and count the parent's own work separately. No family billing framework or double counting of child work in the parent.                                                                                                                                                                                                      |
| Archive/deletion while pinned | Preserve the immutable version needed by retained publications/runs. Archive blocks fresh child acceptance; already accepted children continue. Before archiving, the editor warns and lists the published parents that pin this workflow. A retained pin preserves data and identity, not a lifecycle exemption. Workspace deletion uses its existing cancellation/purge path.                                                                                                                    |
| Unknown outcome               | A child `outcome_unknown` makes the required Call and a still-live parent unknown through existing transition rules. Stop other live direct children through ordinary control intents. Late child completion is history, never permission to rewrite a terminal parent.                                                                                                                                 |
| Recursion / workspace         | Reject any ancestor workflow identity repeated on a call path, including another version. Shared sibling dependencies remain legal. All targets stay in the parent's workspace.                                                                                                                                                                                                                         |
| Worker / run capacity         | Waiting releases the worker job and hands the parent's workspace active-run slot to its child. Completion returns that same slot to the live parent; workspace capacity alone never fails the Call, including at limit one.                                                                                                                                                                                                                        |

F10 human waiting extends the execution-clock part of this decision under
[ADR 076](../adr/076-durable-human-tasks.md): accepted descendants and unstarted
sibling Calls preserve remaining budgets across human quiescence. Absolute wall
deadlines remain fixed, expired Calls cannot revive, and retry never resets them.

Archive behavior deliberately follows the current glossary's distinction between
new admission and an already accepted run. It avoids the former sealed-family
lifecycle/authority protocol. The owner accepted this behavior, with the archive warning, on 2026-10-10.

## Callable contract and bounded execution

Use a small model-owned type descriptor for scalar JSON, bounded arrays and
closed objects, with required properties. Validate it with existing bounded JSON
machinery; do not mistake the SDK's schema-document object check for runtime
validation, or add a general JSON Schema interpreter. No coercion, code,
references, remote resolution or defaults inserted into accepted input. The SDK
adapter projects metadata for the existing editor renderer.

Use the existing `core.manual` or `core.webhook` graph entry for first delivery:
both declare bounded JSON input/output and pass input through. The Call supplies
ordinary `run_input` there; the callable declaration narrows its accepted shape.
`core.schedule` declares a trigger-ID/node-ID/scheduled-time envelope, so
arbitrary call input would contradict that entry contract. Reject it as a
callable target in this slice instead of synthesizing an event or building a
second entry framework. A parent may start by any existing trigger. Validate
callable input once at acceptance and the result once at completion; inner
layers consume the parsed values.

First call values must fit the existing inline stored-value contract: 256 KiB
including the wrapper, depth 64 and 10,000 members. The checkpoint holds
references, not these values. Preserve the current distinction from the SDK's 1
MiB node-value bound and the separate 256 KiB checkpoint bound. Do not borrow
artifact IDs across run ownership or add native framing to bypass those limits.

A callable declaration selects one explicit result using current value-source
rules. A node-output selection must resolve to exactly one successful scoped
invocation; missing/skipped or ambiguous outputs fail, even when values compare
equal. Validate the selected result before committing child success. Failure,
cancellation, timeout and unknown outcome retain their ordinary status rather
than pretending to return null. Call output becomes visible only after validated
child completion; internal declaration input is not its returned output. A
failed/canceled/timed-out child fails a still-live required Call with its safe
reason, then the parent through current failure rules; no error-routing feature
is added. The parent's own cancellation/deadline takes its ordinary status.
Unknown remains unknown. A terminal parent is never rewritten by any child fact.

Publication checks the immutable dependency closure without inlining child
graphs. Recommend applying the existing expanded-invocation cap to the weighted
closure (including repeated call sites and For Each products), initially 200.
Memoize validated version summaries during that bounded walk and stop on
overflow. This derives a bound without a new family quota table or arbitrary
depth limit. A later limit increase follows the pruning measurements below; this
plan changes no existing limit by itself.

## Durable call identity and actions

One typed call record, keyed by workspace, parent run and full invocation key,
owns the immutable pin/input identity and either one child or a definite
refusal. Branch and iteration scope are part of that existing key. Durable
identity must survive the 24-hour HTTP request-receipt window. Exact redelivery
resolves the record first; it cannot allocate another child after
capacity/lifecycle changes. Conflicting identities are rejected. Ordinary
acceptance uses a call-specific receipt scope and digest derived from this
recorded identity, without colliding with manual-start receipts. An explicit
parent replay is a new run.

The pure engine returns a Call wait plus a spawn intent. The database persists
that intent with the parent checkpoint CAS and normal event/outbox transaction.
An ordinary parent advance delivery then invokes the execution child-acceptance
action. The action uses a workspace-scoped maintenance transaction, its existing
reservation grant and the shared acceptance implementation. Run this action
before opening the normal parent advance/store transaction; never open a second
pool from its decision callback. There is no app-role grant to the unrestricted
cross-workspace reservation function, SQL authority proof helper, writer
trigger, new role or public child-start endpoint.

The spawn transaction takes workspace authority and the direct target's ordinary
workflow, entitlement and notification-policy locks, with its immutable version
read/FK lock, before the parent run (`NO KEY UPDATE`) and pending call record.
It then allocates the new child's rows; all prerequisite/FK locks precede the
admission counter. Reuse existing lock helpers where row-lock privileges require
them, rather than granting UPDATE on immutable version tables. It checks the
still live recorded Call wait and immutable intent; it does not recompute
mappings. Insert child run/checkpoint/event/outbox through shared acceptance and bind the
call record with the parent's slot handoff in that same transaction. Record the
exact slot owner/return target using the call relation and existing admission
storage; do not infer ownership from run status or a reservation function's
boolean (its control-only path may return true without granting a slot). An
outstanding slot loan leaves later parallel intents pending with no candidate
child or execution outbox. Target workflow capacity/FIFO, lifecycle/contract
refusal or expiry rolls back all
candidate effects and commits one definite failure and parent wakeup. Unknown
commit retries recover the same recorded child, pending intent or refusal.
Never persist an unreserved queued child behind its parent.

The parent-intent and spawn transactions are separate durable steps, not a
cross-pool transaction. A crash between them leaves replayable intent, with no
child effect. Existing `advance-workflow-run` messages remain identifier hints;
the recorded call state selects the action. No new queue protocol or CI job. The
maintenance action must validate the authoritative delivery/checksum before
acting, while receipt completion stays with the normal advance owner. Recovery
of a committed action before receipt completion must be an explicit tested case.

## Capacity, locks and cancellation

The owner chose **slot handoff**: a durably waiting parent lends its workspace
active-run slot to the child; it does not consume a second workspace slot. The
same slot returns to the live parent when the child finishes. A chain can run at
workspace limit one; five waiting parents and five executing children consume
five slots at the default limit, not ten. This is a transfer of existing
admission capacity, not a family quota, a new role or an unbounded exemption.

A workspace slot has exactly one execution owner at a time. The parent must
finish or suspend its already dispatched ordinary work before lending it and
cannot dispatch new node work while the loan is outstanding. Nested calls pass
the same slot along their direct-call chain and return it one level at a time.
If several Call intents become ready in parallel, lend the slot to one in stable
invocation order and keep the others as durable pending intents; after return,
advance the parent and lend it again. First delivery serializes these children
rather than requiring extra workspace slots. Do not turn saturation into a Call
failure or introduce a second parallel-child admission mode.

Child workflow concurrency/FIFO rules still apply: their definite refusal
fails the Call without creating an unreserved queued child, as otherwise
recommended and accepted. Preserve the waiting parent's existing per-workflow claim so
unrelated runs cannot steal its continuation; the child must respect its target
workflow's own limit. At most one loan can consume a workspace slot, even when
several workflows retain logical concurrency claims. No recursion means a chain
cannot wait on its own workflow claim; target refusal also prevents opposing
chains from waiting indefinitely on one another's workflow claims.

Extend the existing admission tables/functions, counters and all capacity reads
for this invariant: exclude lending parents from workspace executing occupancy,
count the current borrower once, and preserve return rights. Current functions
count every `running`/`waiting` row, so merely releasing a reservation is
insufficient. Keep admission arithmetic and atomic transfer in the plan's
allowed SQL capacity category; intent/pin/authority rules remain TypeScript.
Initial start/FIFO limits remain unchanged. A later limit reduction cannot
revoke an already accepted slot or force the returning parent to re-enter FIFO.

Spawn, slot ownership and call binding commit atomically under workspace-first
locks, the parent/call relation and existing admission counter last. Completion
records a durable return obligation with its terminal fact; execution's parent
advance performs the idempotent return before ordinary parent work. That return
moves existing capacity, never competes for fresh capacity or drops the slot
between transactions. A terminal/canceled parent cannot take it back or resume;
keep the borrower fenced until its ordinary control settlement, then release
exactly once. Nested parent close unwinds direct loan obligations without
simultaneously locking existing ancestor/descendant runs. Outbox arm/rebind,
recovery and retention must preserve current owner/return target and cannot
release a borrowed slot as an ordinary expired reservation.

Evidence must cover cap one, all five default slots lent at once, sequential
parallel intents, nested calls, target FIFO/capacity refusal, lowered limits, crash on
either side of handoff/return, duplicate wakeups, parent close and workspace
purge. Prove counter/ownership conservation and that no parent/child node work
runs concurrently on the same slot. Existing maintenance authority owns these
transactions; no new role, queue protocol or family ledger.

Child terminal persistence records the result/fact and parent wakeup atomically
in the child's transaction, without locking the parent run/checkpoint. Parent
advancement consumes that fact through its ordinary CAS; duplicate wakeups are
inert. Extend the existing completed-output reference to the immutable call
result rather than fabricating an executor attempt output or a second history.
First results use the unchanged inline stored-value wrapper.

Parent close records direct-child cancellation intents. Each child processes its
own cancellation in a short transaction, then propagates to its own direct
children if needed. Do not hold parent and existing child run locks together.
Serialize spawn against parent close with the parent lock; a closed parent gets
no new child. Workspace deletion's exclusive workspace lock fences new spawn.
Exercise opposing spawn/close, completion/close, dispatcher/counter and purge
writers with real PostgreSQL tests, not a deadlock retry policy.

A call has a distinct persisted origin; it must not impersonate a manual,
schedule or webhook request. It uses the declared Manual/Webhook JSON entry and
does not fire/install external triggers. The entry restriction follows the
current input contracts, not the parent's trigger type. Existing
automatic-trigger pause accounting continues for scheduled/webhook origins;
called runs have no synthetic trigger history. Child and parent failure
notifications follow each run's ordinary policy.

## Retention and truthful history

Retain pins/facts required by a live parent; a purge must not erase an
unconsumed child result. Once the Call settles, input/result detail follows
existing run retention. Preserve a small identity/status stub until the parent
retry/history frontier expires, and allow child detail retirement without
retaining a whole run family forever. Reads distinguish retained detail from
expired history and apply current `run:read` authority independently to both
runs. No durable graph copies, family archive or alternate audit stream.

Recommend one call row owned by its parent, removed with parent-summary purge.
Keep the stable child ID in its outcome identity separately from a nullable live
child reference; ordinary child-summary retirement can detach that reference
without erasing the outcome. Clear input/result payloads only after parent
consumption and the applicable detail window. Published parent dependency edges
retain exact child versions through workspace-qualified foreign keys; workspace
purge removes dependent publications/call rows before the pinned versions.

The first schema slice must prove that representation with existing 30-day
detail and 90-day summary rules, receipt expiry and live-parent exceptions.
Existing outbox/receipt recovery must require the live parent/record and cannot
resurrect a child after detail retirement or parent deletion.

## Finished-iteration pruning before raising limits

[ADR 020](../adr/020-bounded-for-each.md) records why limits are currently 200:
before pruning, finished invocations stayed in the checkpoint; maximum-ID For
Each peaked at 141 KB, nested loops at 191 KB and a chain at 87 KB. The
checkpoint is capped at 256 KiB and rewritten on every transition. Raising its
cap multiplies write volume.

After an iteration is terminal and no live invocation needs its data, remove its
invocations, joins, branch selections, nested loop states, completed-output
references and admission keys from the checkpoint. Inspectable outputs remain in
ordinary durable attempt/run storage. Retain the collection reference,
next-ordinal cursor, remaining budget, active scopes and a compact completed
prefix with bounded out-of-order terminal ordinals. A per-finished-invocation
checkpoint tombstone is not pruning.

`transition/loops.ts:applyLoopCompletion` used to look up the iteration before
checking `terminalOrdinals`. Recover around the compact terminal frontier so a
valid redelivery of a pruned completion is inert. Immutable attempt/call facts
and receipts remain the boundary for conflicting changed completions; do not
silently accept a rebound output or re-admit a finished key. Update fact loading
and checkpoint reconstruction together. Keep data needed by live downstream
mappings, joins or nested scopes until their ownership ends.

The pruning slice covers out-of-order/nested completion, restart, duplicate and
conflicting delivery, canceled/failed/unknown loops, existing durable waits,
retention, and late facts after pruning. Call waits within loops are qualified
in slice 3, when Call execution exists. Measure checkpoint bytes and actual
PostgreSQL rewrite volume with maximum IDs and values. Keep all current limits
until those tests prove a bounded active frontier; then propose loop/expanded
limit changes separately from static node, ID and concurrency bounds. No
automatic restoration of the old 1,000 limits.

### Slice 1 implementation and evidence (2026-10-10)

The engine prunes a terminal iteration only when every invocation in its full
branch/iteration subtree is terminal. Waiting or still running owners keep the
scope's references. Joins, branch selections, admission keys and nested loop
declarations leave with that subtree. Ordinary node runs, attempts, outputs and
events remain the history/inspection owners; pruning does not delete history.

Each retained loop records `completedPrefix`: every ordinal below it has settled
and released its data. Out-of-order completed ordinals retain only their ordinal
until the gap closes, bounded by the current iteration limit. Admission still
uses active iteration count; a slow first item does not serialize later items.
Removed nested declarations contribute to one positive `retiredIterationBudget`
total, omitted when nothing has retired. It preserves full-budget reservation
without a refund or per-invocation tombstones. The parser verifies
frontier/cursor coverage and budget conservation.

`prunedInvocations` is a transient transition-plan field, used only to finish
the current transaction's node admissions and pending failure decisions. It is
never stored in the checkpoint. The existing fact loader reads from
`nextEventSequence`; receipt recovery precedes replay. Immutable attempt
completion still rejects changed outputs after checkpoint records disappear. The
private coordinator accepts a derived completion behind the compact frontier as
inert; public unverifiable outcomes for removed keys remain invalid.

Evidence lives in the existing suites:

- Engine pruning tests cover out-of-order completion, JSON restart, inert
  redelivery, no repeated admission, waiting ownership, joins/branches, nested
  budget retirement and malformed frontiers. Compiled-loop tests cover
  retry/failure, cancellation, deadlines and unknown outcomes, and reject both
  stale and fresh public outcomes for pruned keys.
- Capacity tests retain maximum-length identifiers and add serial, nested and
  out-of-order loops with collection values within about 500 bytes of the 256
  KiB stored-value bound. Their checkpoints peak below 8 KiB and retain no
  finished iteration invocations. Full parallel loops retain their live
  frontier.
- PostgreSQL tests prove terminal pending failure decisions persist when their
  invocation is pruned, and identical/conflicting physical completions remain
  respectively inert/rejected after removal of checkpoint invocation records.
- The real PostgreSQL/Redis worker fixture completes serial, Condition, Switch
  and nested loops, erases transport state and restarts a fresh process after
  each pruned iteration, then redelivers an old attempt. History counts do not
  increase. Cancellation between/running batches and running deadlines keep
  their prior behavior. Live history survives retention; after 31-day detail
  retirement, late delivery cannot recreate history or the checkpoint.

One-off before/after measurements use maximum-length identifiers and about 255
KB of collection JSON in each declaration, at the unchanged limits:

| Scenario                     | Checkpoint updates | Peak bytes before → after | Serialized rewrite bytes before → after | PostgreSQL WAL bytes before → after |
| ---------------------------- | -----------------: | ------------------------: | --------------------------------------: | ----------------------------------: |
| Serial For Each, 197 items   |                201 |           140,773 → 2,540 |                    14,462,533 → 507,217 |                 1,697,169 → 263,802 |
| Parallel For Each, 197 items |                  8 |         140,773 → 124,331 |                       951,524 → 267,318 |                     88,885 → 30,070 |
| Serial nested loops, 14 × 12 |                214 |           190,946 → 4,387 |                    20,990,568 → 885,119 |                 1,984,753 → 326,307 |

Serialized rewrite bytes sum every checkpoint JSON submitted by the engine. WAL
bytes come from `EXPLAIN (ANALYZE, WAL, BUFFERS, FORMAT JSON)` for each
committed update in a disposable PostgreSQL 18 database. The logged table uses
the production checkpoint columns, checks, primary key and resume index; it
isolates checkpoint writes and excludes the run transaction's history, receipts,
foreign keys and artifact trigger. These are measured checkpoint WAL costs, not
total run WAL. Serial/nested checkpoint WAL falls by about 84%; a fully parallel
live frontier remains much larger than a serial one. No bound is raised, and
Call-in-loop evidence remains required before any later increase.

## Slice 5: measured loop limits (2026-10-17)

Status: implemented and locally qualified; green CI required before merge.
The owner authorized a
measured increase to at least 1,000 and at most 5,000, retaining the checkpoint
cap and ordinary capacity. No new infrastructure, subsystem, role or stored
format.

Choose **4,998 items per loop**, matching the collection cap, **5,000 total loop
iterations** and **5,000 expanded invocations**, including the weighted Call
closure. Static graph size stays 200 nodes, identifiers stay 64 characters, and
per-loop concurrency stays at most 200. Actual legal concurrency also depends
on a conservative **200-invocation concurrent expansion** check. It uses the
existing graph traversal, multiplying each body by `maxConcurrency` instead of
`maxIterations`, and sums retained ordinary nodes. Publish errors tell the author
to reduce Items at a time, including in nested loops. All previously accepted
200-expansion graphs pass this check. No checkpoint field or scheduler behavior
changes; loop history is pruned by its existing owner.

A naive count-only increase fails the nested 2 × 2,498 case with 2 × 200 active
items: the real engine rejects a checkpoint over 256 KiB. The frontier check
rejects this graph before publishing. With outer concurrency 2 and inner 98,
the same maximum total work fits with 200 retained invocations. This is why the
concurrency/frontier bounds remain separate from total work.

Limits include the whole graph: a minimal Manual → For each → one body step
uses 5,000 invocations for 4,998 items. A following Stop lowers that to 4,997;
more body steps reduce it further. A minimal one-step callable child permits
2,499 Call iterations (2 local controls plus two invocations per iteration).
Batching is a bulk-operation pattern, not a refund or a bypass for nested loops,
Call closure or JSON limits. The guides explain 4,998 IDs → batches of 100 → 50
iterations, and splitting oversized source datasets into separate bounded runs.

### Reading large histories

Run snapshots and Call history now use the model-owned expanded-invocation bound
rather than the old 1,000-node / 200-Call read limits. The response shape stays
the same. Database boundary tests read 5,000 records and reject overflow.
Thread, step results and child Calls show 50 entries per page, while the full
snapshot still supplies graph statuses and selected-step inspection. A newly
selected step opens its page; live refreshes preserve manual page navigation.
Desktop and phone browser cases cover a maximum 5,000-weighted-invocation Call
history (2,501 parent invocations and 2,499 child Calls). Output summaries retain
the existing 25-step threshold to avoid a request per output on large runs.

### Cancellation correction found by qualification

A wide loop exposed an existing attempt-claim refusal: cancellation/deadline
activation rejected an already-admitted ready delivery before it could acquire
a lease. Its checkpoint invocation remained running with no physical completion.
The serial fixture passed; the same wide fixture reproduced the stuck run and
failed ready jobs. Allow the existing lease claim so the handler's existing
input-control check records the ordinary canceled/timed-out outcome before SDK
execution. Lease/fence/receipt ownership and prior-dispatch uncertainty remain
unchanged. Remove the obsolete refusal and its unused error type; do not add a
reconciliation subsystem or duplicate completion policy. Real storage tests set
control before claim, then verify control input, terminal completion and no
dispatch marker. Worker tests cover cancel and deadline after a maximum loop
has started, and prove newly claimed work after activation never dispatches.
Already in-flight work retains ordinary cooperative-control semantics.

### Reproducible evidence

`database/test/runs/loops/capacity.integration.test.ts` exercises eight maximum
weighted-expansion scenarios through the real engine and checkpoint restart
parser. Collection values approach the unchanged 256 KiB retained-value bound;
node IDs have 64 characters (the Parallel control uses 63 to reach the existing
256-character scoped invocation-key bound). Identifier and combined-key bounds
remain unchanged. Every checkpoint stays below 90% of the unchanged
256 KiB engine cap. Completed iteration records are pruned; a held first item
also measures the bounded out-of-order ordinal frontier.

The optional WAL measurement runs with `PERTEXO_LOOP_CAPACITY_MEASURE=1` in the
existing database integration runner and requires its ordinary isolated
PostgreSQL fixture/config. No new CI job or production test hook. It creates a
logged `LIKE run_checkpoints INCLUDING ALL` table in a disposable database and
uses `EXPLAIN (ANALYZE, WAL, BUFFERS, FORMAT JSON)` for committed checkpoint
inserts/updates. It includes child checkpoints, but excludes run history,
receipts, Call/admission/outbox rows, foreign keys and artifact triggers. Its WAL
numbers are checkpoint-write costs, **not whole-run WAL**. Serialized bytes sum
every parent and child checkpoint submitted; initial inserts and updates are
reported separately. Normal CI keeps maximum-size engine cases, over-limit
publication checks and real worker fairness tests; WAL timing is an opt-in
qualification, not a machine-speed assertion.

Measured on 2026-10-17 with Node 24.15.0, arm64 macOS and the existing isolated
PostgreSQL 18.6 container (`full_page_writes=on`, `wal_compression=off`). Every
case uses exactly 5,000 weighted invocations. WAL varies with page/checkpoint
state; these observations are not machine-independent thresholds.

| Scenario | Inserts | Updates | Peak checkpoint bytes | Submitted bytes | Checkpoint WAL bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Serial 4,998; concurrency 1 | 1 | 5,000 | 2,552 | 12,745,316 | 6,323,377 |
| Concurrent 4,998; concurrency 198 | 1 | 502 | 148,335 | 67,236,435 | 7,875,214 |
| 4,998; first item held, concurrency 2 | 1 | 5,000 | 27,038 | 73,218,811 | 54,783,601 |
| Nested 2 × 2,498; concurrency 1 × 1 | 1 | 5,002 | 4,394 | 21,880,888 | 7,693,731 |
| Nested 2 × 2,498; concurrency 2 × 98 | 1 | 504 | 183,758 | 66,975,612 | 5,172,239 |
| Parallel/Merge body, 1,249 × 4 steps; concurrency 49 | 1 | 504 | 186,426 | 85,410,128 | 8,000,919 |
| 2,499 Calls; concurrency 1 | 2,500 | 7,499 | 2,582 | 16,420,796 | 11,325,711 |
| 2,499 Calls; concurrency 198 | 2,500 | 5,001 | 141,516 | 331,597,068 | 31,642,634 |

The widest measured checkpoint is **186,426 bytes** (71.1% of 262,144), leaving
75,718 bytes of headroom. Fully nested and Call frontiers stay at 200 invocation
records. A held first item reaches only 27,038 checkpoint bytes but rewrites its
growing ordinal frontier many times; that case generates about 55 MB of
checkpoint WAL. The default serial Call case submits about 16 MB versus 332 MB
at concurrency 198. Keep the default `1` for Calls; higher concurrency cannot
parallelize their borrowed-slot children. No checkpoint, member, value or
ordinary capacity cap is raised to make these results fit.

The real PostgreSQL/Redis worker fixtures first start each maximum numeric-list
workload, then accept short workflows in the same and another workspace. Both
short runs finish while the large run remains active. The measured interval
starts after their acceptance, includes dispatcher/worker progress, and is not a
latency SLA. The default workspace limit stays five; no extra worker concurrency
or bypass is used. Cancellation/deadline then settle the large run and release
all admissions. New claims after control activation have no dispatch marker.

| Maximum workload | Control tested | Quiet-run completion (ms) | Peak occupied workspace slots |
| --- | --- | ---: | ---: |
| parallel | canceled | 3,990 | 2 |
| nested | canceled | 4,677 | 2 |
| call | canceled | 9,537 | 2 |
| parallel | timed_out | 3,988 | 2 |

These worker cases cancel after the fairness witness; they do **not** claim the
wall time or full transaction WAL for completing 2,499 real child runs. The
complete eight-case engine/checkpoint-write fixtures simulate executor/child
facts and finish every iteration, recovering through the parser each time. The
existing Call capacity/control suites separately qualify real slot handoff,
returns, restart, receipts and unchanged default-five/capacity-one behavior.

Reproduce with the ordinary database integration fixture environment:

```sh
PERTEXO_LOOP_CAPACITY_MEASURE=1 pnpm --filter @pertexo/database exec vitest run --config vitest.integration.config.ts test/runs/loops/capacity.integration.test.ts
pnpm --filter @pertexo/worker exec vitest run --config vitest.integration.config.ts test/runs/loops/fairness.integration.test.ts
```

Qualification so far: all eight maximum-size scenarios and the over-limit
refusal pass in the final measurement run. Four real worker stress/control
cases, 36 storage/capacity cases, 376 model tests, 458 engine tests and 244
core-node tests pass. The history follow-up adds a 26-case database API pass,
including exact 5,000-entry boundaries and overflow refusals. Full build, lint,
type checks, 9,478 unit tests (659 Vitest files), 198 mocked browser tests,
contracts, 97-table schema ownership, architecture, dependencies and formatting
pass. A contended default-worker unit pass timed out unrelated editor cases;
all unchanged assertions pass with two workers, without raising timeouts or
changing test configuration. The final two ready-control storage cases pass
again after fixture cleanup. React Doctor's eight-file changed scan is 100/100;
no whole-application score is claimed. A later live file-input job exposed an
existing verifier error before its reader attached: the worker crashed and the
next run stayed queued. Node's stream completion monitoring now owns transfer
errors immediately while returning the original terminal error to the consumer.
The SDK retains ownership of consumption: making the returned transform a
pipeline destination stalled RustFS uploads at the unchanged five-second
request deadline, while completion monitoring preserves the original flow.
Three subprocess regressions reproduce pre-reader timeout, upstream failure
and premature close; they also prove source cleanup and abort-listener removal.
The seven live file browser cases and the full cached-RustFS encrypted backup
and restore qualification pass with the original request deadline. Storage integrity,
file limits, formats and the loop measurements are unchanged. CI remains
required before merge.

## Delivery slices and evidence

### Slice 2 implementation and evidence (2026-10-11)

Callable declarations now use six JSON value kinds, bounded arrays and closed
objects. Object properties are ordered entries with their own `required` flag;
this follows the recommended small descriptor rather than duplicating names in
a separate required-property list. The ordinary bounded graph parser owns the
untrusted declaration boundary. Accepted input is cloned and validated once
before fresh acceptance effects; an accepted receipt is recovered before the
callable validator runs again. Manual, Webhook and replay acceptance share this
path. A callable declaration requires one enabled Manual/Webhook entry.

The immutable executable retains the declaration and includes it in its existing
checksum. A fresh success is provisional until execution resolves and validates
the selected result. The database provides an on-demand reader within the same
locked advance transaction, including retained outputs from pruned scopes.
Selection requires one physical successful invocation; equal values from two
invocations remain ambiguous. Missing, invalid, ambiguous or oversized results
produce a safe run-level failure without changing successful node outcomes.
The ordinary run stores the inline result and notification intent. No checkpoint
result copy, artifact borrowing or replacement format is introduced.

The editor authors the declaration as one undoable draft edit. Local property
identities preserve focus while names change; inline errors focus the invalid
field. Reader access can inspect the contract without saving it. The existing
dialog owns keyboard focus and discard confirmation, with a scrolling body and
visible actions on a narrow screen. Public controls describe standalone
contracts; Call pins and the memoized weighted dependency validator remain
private until slice 3 exposes supported Call execution.

Qualification uses existing test owners, including the existing editor CI job:

- Model tests cover closed properties, own `__proto__` names, depth and member
  bounds, required values, disabled/unsupported entries, result paths and
  private exact-pin/workspace/cycle/weighted-closure behavior.
- Engine and execution tests cover checksum identity, input cloning, stored
  wrapper bounds, selection ambiguity, missing paths, artifacts, expression
  evaluation/abort and provisional success settlement.
- Real PostgreSQL tests cover no acceptance effects on invalid input, immutable
  accepted input, receipt recovery and one notification intent when every node
  succeeded but the declared result failed.
- Real PostgreSQL/Redis workers complete valid input and JSONata results, reject
  invalid input before acceptance, persist safe result failures, and retain one
  terminal outcome after fresh-worker restart and transport redelivery.
- The real API/editor browser fixture authors with keyboard controls, publishes
  two immutable contracts, rejects missing/type/extra-property HTTP input, runs
  a valid result and a missing-path failure, and verifies stored identities,
  output, events and successful node history. Desktop and 390-pixel layouts
  retain visible dialog actions.
- Frontend qualification passes 1,053 existing/new unit tests plus the added
  reader case in the focused three-test suite, and all 93 browser tests. React
  Doctor reports 100/100 with no diagnostics on the changed React files; this
  is a regression scan, not a new whole-application score. An initial combined
  run overloaded local workers and timed out; bounded reruns passed. The mobile
  header test also exposed a real oversized contract action, corrected before
  the successful rerun.

The full repository check passes. The complete live database suite passes 681
tests (46 optional tests skipped); the real worker callable suite passes all
four cases and the real editor/API fixture passes. The final changed-file React
Doctor scan covers 12 files. Commit and CI evidence accompany the slice PR.
This slice adds about 3,380 authored lines, including tests and documentation;
the generated contract artifacts add 4,440 and remove 84 lines. This excludes
slice 1 pruning. The remaining Call/control work still needs its own evidence
and size comparison against the 4,000–8,000 authored-line forecast.

### Slice 3 storage qualification

The first Call schema checkpoint adds parent-owned scoped call identities,
workspace-qualified publication pins and a nullable live child reference beside
the stable child outcome ID. It extends existing admission storage with the
direct call return target. The incremental migration preserves the recorded
baseline and uses the existing owner, application and maintenance roles with
forced row security. These tables do not yet expose supported Call execution.

Real PostgreSQL lifecycle tests prove child detail retirement at 30 days,
child-summary detachment at 90 days while a live parent retains its result,
parent-owned payload and identity retirement, live-input exceptions before and
after intent creation, outstanding slot-return protection, completion-lock
coordination, receipt expiry, cross-workspace rejection and dependency-ordered
workspace purge. Parent/child execution and capacity conservation remain
required before slice 3 is complete.

The full live database suite passes 690 tests, with 46 optional cases skipped;
all 526 database unit tests pass. The nine-case Call lifecycle suite also proves
purge ordering with an actual borrowed admission row and empty application
reads without workspace context. Existing repository build, lint, type checks,
dependency, contract, schema-ownership and architecture checks qualify this
storage checkpoint. No Call runtime or editor support is claimed by it.

### Slice 3 capacity qualification

The next storage checkpoint makes the existing admission row the current slot
owner, with a direct Call return target. A transfer moves that row down a nested
chain and returns it one level at a time. Lending parents keep their workflow
concurrency claims; workspace occupancy excludes them and counts each borrower
once. A terminal borrower retains a reserved return right until the parent action
returns or releases it. Ordinary dispatcher/receipt release, outbox rebinding
and recovery preserve borrowed ownership. One SQL occupancy rule serves the
capacity functions, counters and public reads, using active/queued predicates
and the admission relation rather than scanning retired run history.

Sixteen live PostgreSQL cases prove capacity one, all five default slots,
current-policy reduction before fresh child acceptance, nested and parallel
transfers, closed root/nested unwind, target concurrency refusal, duplicate
return, ordinary-release fencing, failed/published hint recovery and terminal
return recovery. A one-row recovery batch progresses past active or unpublished
borrowers. Opposing-writer tests prove the return does not lock the existing
child and a parent writer does not block child settlement. The full live
database suite passes 706 tests (46 optional tests skipped),
and all 526 database unit tests pass. The existing concurrency and
Call-retirement suites pass all 41 cases. These are storage and
capacity proofs; atomic runtime spawn, ordinary-work exclusion and the complete
Call editor/worker path remain required before slice 3 is complete.

### Slice 3 engine qualification

The pure engine separates prepared Call input from the child result. Physical
SDK success produces one immutable intent and a durable Call wait without a
timer; a relational child outcome settles that invocation with a Call result
reference. Parent cancellation, deadline and unknown-outcome rules remain the
ordinary engine rules. An explicit execution-slot input prevents admissions and
continuation polling while the parent lends its slot.

All 396 engine tests and 209 model tests pass. Call cases cover JSON checkpoint
restart, duplicate/conflicting outcomes, malformed and fabricated scopes, late
child completion after parent termination, child failure/unknown, Call sinks in
finished-loop pruning and ready ordinary work without an execution slot. These
are pure transition proofs; durable intent persistence, atomic child acceptance,
result loading, worker recovery and the editor remain unfinished. Call is not
yet registered in the serving node catalog, and slice 3 remains incomplete.

### Slice 3 persistence and action qualification

The next private checkpoint persists the Call intent, logical wait and wakeup in
one parent checkpoint transaction. The child's terminal transaction writes its
immutable fact and parent wakeup without a parent run/checkpoint lock. Result
readers resolve the Call relation rather than SDK declaration input, including
the callable result reader. Normal parent CAS consumes the fact and retains its
small identity. Parent close records direct cancellation and wakes each child;
the child applies its ordinary control in its own transaction.

A workspace-scoped maintenance action runs before ordinary advancement. It
recovers the recorded child before fresh target checks, uses shared run
acceptance and transfers the existing admission row atomically. A candidate
refusal rolls back child, checkpoint, event, receipt and outbox effects. Target
and notification prerequisites precede parent locking; the counter remains last.
The existing workspace admission lock now also pins current entitlements before
run locking. Immutable workflow versions stay read-only; the three existing
roles and forced row security are unchanged.

All 720 live database tests pass (46 optional tests skipped), as do 526 database
unit tests, 209 model tests and 14 execution tests. Fourteen new PostgreSQL cases
cover declaration atomicity, rebound rollback, wrapper bounds, independent child
completion under a held parent lock, result ownership/consumption, capacity-one
acceptance, pre-commit interruption, post-commit recovery after receipt expiry,
target/archive/input refusals, dispatched ordinary work, fixed accepted pin and
deadline, transport mismatch, direct child control and closed-parent loan release.
The repository check passes. Storage tests script transitions to qualify their
transaction owner; they do not claim real worker or browser execution. Worker
composition, publication dependency enforcement, the serving Call adapter,
editor picker and integrated recovery/loop/history proofs remain unfinished.
At this persistence checkpoint, slice 3 was not complete; integrated evidence
is recorded below.

### Slices 3–4 integrated qualification (2026-10-11)

The serving catalog supports `core.call@1`. Its SDK executor prepares input;
child acceptance remains an execution action through the coordinator-owned
maintenance store, required by the execution seam. Publication validates exact
same-workspace pins, callable contracts, workflow-identity cycles and the
memoized weighted closure at 200. Repeated sites and For Each products count;
shared siblings remain legal. Current published-parent discovery extends the
existing bounded workflow list read, including cursors bound to the pinned child,
pagination and superseded pins.

Fourteen real PostgreSQL/Redis worker cases cover typed completion after worker
restart and receipt expiry, nested handoff at capacity one, all five default
slots lent, stable parallel ordering with no second unreserved child, scoped
Calls in two pruned serial iterations, authoritative action redelivery before
receipt completion, public result/origin/lineage reads, nested parent close,
independent child cancellation, inherited and narrowed deadlines, invalid
results, unknown outcome and accepted continuation after archive/member
revocation. The PostgreSQL action suite separately stops before spawn commit
and recovers after spawn commit before receipt completion. The parent retains
its own timeout; at a shared deadline the child’s ordinary timeout and direct
parent-close cancellation race, so its first settled control wins.

Opposing-writer PostgreSQL tests hold the parent row while a spawn action blocks,
then commit cancellation intent or terminal cancellation. Neither case allocates
a child or lends a slot. Child completion and slot return also remain independent
of an opposing parent or child writer, respectively.

The existing owned callable browser case now has two journeys. It proves the
ordinary contract flow plus browser-created Call selection, immutable version
1 after a newer child publication, explicit upgrade to version 2, validated
results through real workers, current parent/child links, mobile archive warning
with the published parent’s name, and a fresh archived-target refusal without
allocating a child. Private SQL verification checks retained calls, results,
origins, dependencies and empty borrowed admissions. Desktop picker and mobile
archive screenshots were inspected. No new CI job, browser case or production
test hook was added.

The existing core unit job includes the execution package explicitly, so Call
action orchestration proofs run in CI alongside the engine and database suites.

CI exposed an existing statistics fixture transaction started through
`Pool.query`: slow seeding let the pool's idle timeout close its snapshot.
The focused case reproduced the same 82-page failure locally. It now holds one
checked-out client through rollback and verifies the pre-insert snapshot still
sees no runs after seeding, with a short idle-pool timeout to exercise eviction.
The zero all-visible-page and final zero-heap-fetch assertions remain intact.

Current run detail returns safe Call metadata in its existing authorized
workspace snapshot. Results stay hidden until logical completion. Detached
90-day child summaries display expired history while retaining the Call’s
identity/outcome; retired 30-day Call input/results are labeled expired. The
same lifecycle suite proves outstanding-loan protection and dependency-ordered
workspace purge. Ordinary run statistics count the child once under its own
workflow and the parent’s work once under the parent. Failure-notification
persistence keeps one intent/outbox per failed run and preserves the distinct
`workflow_call` origin. There is no family billing layer.

The exact-version picker uses the existing Query/version doors and scoped editor
history. Version discovery loads one page at a time on demand; the current pin
uses an exact-version filter on the existing authorized list read, so an old pin
never requires scanning newer history. Its named Call composition is separate from ordinary schema controls.
Published-parent warnings share the lifecycle dialog’s Query snapshot. Call
history refreshes only an active visible parent with pending/accepted Calls;
terminal runs stop it. The changed frontend scan is 100/100 with zero React
Doctor findings (18 files); that is a change-scope score, not a whole-app claim.
All 1,058 web unit tests and 93 browser tests pass. Repository/live suite totals
and the authored/generated diff are reported in the PR after the final gates.

Pre-launch rollout applies the three additive migrations before starting the
matching API/worker/catalog build. The only supported stored shapes remain the
current ones. Interrupted waits, admission rebinds, expired HTTP receipts and
terminal borrowers recover through existing hints/receipts. Keep accepted Call
rows and immutable pins through forward fixes; do not roll back by dropping the
relations or installing an older worker that cannot settle them. No production
deployment or destructive rollback was performed. Slice 5 remains separately
reviewable, and no execution/checkpoint/value bound changed.

| Slice                  | Behavior at its end                                                                                                                           | Required evidence                                                                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0. Review              | Accepted callable/pin/authority/capacity/retention decisions and bounded contract                                                             | Owner accepted on 2026-10-10 with slot handoff and archive warning; reconcile exact source/interfaces before each runtime slice                                                                                                                   |
| 1. Pruning             | Existing For Each recovers with finished iterations removed; current limits unchanged                                                         | Engine behavior/capacity tests, real CAS/restart/redelivery, mapping/inspection retention, measured rewrite bytes                                                                                                     |
| 2. Contract            | Callable declarations round-trip and enforce typed input/results on ordinary standalone runs; Call pin contracts remain private until slice 3 | Model/contract units, real HTTP draft/publish/standalone run, invalid input/result, private pin/cycle/closure fixtures and responsive keyboard contract-editor tests                                                  |
| 3. Call                | Register the supported Call node and exact-version picker; one real parent → child → typed result releases its worker job                     | Real PostgreSQL/Redis/worker/browser fixture in existing CI owners; crash before/after spawn commit, duplicate delivery, fresh-worker child wait/recovery, two callers, newer child publication, capacity-one and default-five handoff/return, nested loans and serialized parallel calls |
| 4. Controls/history    | Cancel/deadline/unknown, result errors, notification/usage/lineage and retention behave truthfully                                            | Opposing-writer PostgreSQL tests, late completion, access revocation, workspace deletion, expired detail, input/result bounds and no parent terminal rewrite; real visible browser history                            |
| 5. Limits if justified | A measured larger loop bound with the same checkpoint cap                                                                                     | Maximum-size nested/parallel/Call scenarios, byte/write-volume evidence and unchanged ordinary capacity/fairness; separate reviewed limit choice                                                                      |

Each runtime slice uses current CI suites and commits only coherent tested
behavior. Contracts/editor controls must not advertise unsupported execution:
keep the slice's public support truthful until the Call behavior is delivered,
without adding a permanent rollout subsystem. Mocks do not qualify persistence,
restart, locks or the integrated browser/backend path. No provider provisioning,
paid infrastructure or production deployment is authorized here.

## Size and rollout

The reverted PRs total +110,120 / −11,391 (net +98,729): 149 +28,177/−6,867, 159
+80,145/−4,395, 162 +1,798/−129. These are published PR diff totals and include
repeated/prerequisite work; they are not a unique-file code-size measurement.
They extended parallel graph/checkpoint formats, release/readiness pins, SQL
proofs, native/artifact framing and feature-specific qualification machinery.

Initial forecast: roughly 4,000–8,000 authored lines for contracts, behavior, UI
and tests, plus generated artifacts reported separately. This is a review
forecast, not a cap or permission to omit behavior. Pruning and later limit
changes are reported separately. Compare actual size at every slice and explain
any growth; reconsider the seam before reintroducing the reverted machinery.

Pre-launch development uses the ordinary schema-generation/migration path and
one current format. An installed accepted Call must remain readable/settleable
through forward fixes; rollback must not erase accepted child facts or pins. Use
the current deployment/readiness boundary rather than mixed-format cohorts.

## Prior art checked 2026-10-10

[Temporal](https://docs.temporal.io/child-workflows) models separate child
executions, explicit parent-close behavior and their extra history cost. That
supports using a child for reusable execution, with an explicit close policy.
[Hatchet child spawning](https://docs.hatchet.run/v1/child-spawning) runs
children independently; its
[durable tasks](https://docs.hatchet.run/v1/durable-tasks) checkpoint waits and
can free the worker slot. Pertexo uses its existing checkpoint/outbox instead of
importing Hatchet's event-log architecture.
[n8n Execute Sub-workflow](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executeworkflow)
exposes mapped inputs and an option to await completion. Pertexo uses exact
immutable pins, strict validation and wait-for-result only first. These
references inform the accepted behavior, not acceptance evidence.

## Delivery tracker

- [x] Baseline reconciled against current reset structure and reverted sources.
- [x] Recommended product choices, ownership, delivery slices and size
      comparison written.
- [x] Finished-iteration pruning and limit-increase evidence planned.
- [x] Owner approved the plan and ADR 070 on 2026-10-10, with slot handoff and
      the pinned-parent archive warning; all other recommendations accepted.
- [x] Reset follow-up: deterministic canonical JSON, live organization test
      investigation and 42 redundant filenames implemented and verified.
      Full reset gate and the three live role cases pass; slice 1 starts after
      the follow-up's green CI and merge.
- [x] Slice 1: finished-loop pruning implemented and verified at current limits;
      engine/database/worker restart, delivery, history and retention evidence
      and checkpoint/WAL measurements recorded above.
- [x] Slice 2: callable contract implemented and verified for standalone runs;
      editor, HTTP input/result, immutable executable, real persistence,
      worker restart/redelivery and private dependency evidence recorded above.
- [x] Parent/child acceptance, completion and controls implemented and verified.
- [x] Real integrated editor/history/recovery evidence recorded.
- [x] Call waits inside pruned loops qualified with the slice 3 runtime.
- [x] Call retention and forward-fix rollout guidance verified; limits unchanged.
- [x] Slice 5: owner-authorized 4,998-item / 5,000-total increase implemented and
      locally qualified with the unchanged checkpoint/capacity bounds, a bounded
      active frontier, maximum-size write measurements and real worker fairness.
      Green CI is required before merging the independently reviewable limit PR.

Reusable Workflow Calls, pruning and standalone callable contracts are
implemented. Slice 5 records the owner-authorized larger loop limits; the
intentionally excluded input/entry features remain outside this delivery.
