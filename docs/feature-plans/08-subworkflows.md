# F08 — Reusable subworkflows after the architecture reset

Status: accepted by the owner on 2026-10-10; implementation starts with
finished-loop pruning after the reset follow-up PR. This document replaces the former F08 outline; it does not restore
the reverted implementation. [ADR 070](../adr/070-workflow-call-boundaries.md)
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
- `packages/execution/src/runs/advance-run.ts`, `initial-checkpoint.ts` and
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
finished invocations stay in the checkpoint; maximum-ID For Each peaks at 141
KB, nested loops at 191 KB and a chain at 87 KB. The checkpoint is capped at 256
KiB and rewritten on every transition. Raising its cap multiplies write volume.

After an iteration is terminal and no live invocation needs its data, remove its
invocations, joins, branch selections, nested loop states, completed-output
references and admission keys from the checkpoint. Inspectable outputs remain in
ordinary durable attempt/run storage. Retain the collection reference,
next-ordinal cursor, remaining budget, active scopes and a compact completed
prefix with bounded out-of-order terminal ordinals. A per-finished-invocation
checkpoint tombstone is not pruning.

`transition/loops.ts:applyLoopCompletion` currently looks up the iteration
before checking `terminalOrdinals`. Reorder recovery around the compact terminal
frontier so a valid redelivery of a pruned completion is inert. Immutable
attempt/call facts and receipts remain the boundary for conflicting changed
completions; do not silently accept a rebound output or re-admit a finished key.
Update fact loading and checkpoint reconstruction together. Keep data needed by
live downstream mappings, joins or nested scopes until their ownership ends.

The pruning slice must cover out-of-order/nested completion, restart, duplicate
and conflicting delivery, canceled/failed/unknown loops, Call waits within
loops, retention, and late facts after pruning. Measure checkpoint bytes and
actual PostgreSQL rewrite volume with maximum IDs and values. Keep all current
limits until those tests prove a bounded active frontier; then propose
loop/expanded limit changes separately from static node, ID and concurrency
bounds. No automatic restoration of the old 1,000 limits.

## Delivery slices and evidence

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
- [ ] Reset follow-up PR: deterministic canonical JSON, live organization test
      investigation and remaining redundant file names.
- [ ] Slice 1: finished-loop pruning implemented and verified at current limits.
- [ ] Callable contract implemented and verified.
- [ ] Parent/child acceptance, completion and controls implemented and verified.
- [ ] Real integrated editor/history/recovery evidence recorded.
- [ ] Retention, rollout/rollback and any measured limit change verified.

This PR contains planning only. No F08 runtime behavior or pruning is built.
