# ADR 070: Workflow call boundaries

- **Status:** accepted
- **Date:** 2026-10-10
- **Plan:** [F08 re-plan](../feature-plans/08-subworkflows.md)
- **Foundation:** [ADR 069](069-architecture-reset.md)

## Context

Reusable workflows need durable calls with understandable authorization,
capacity, lifecycle and recovery behavior. The reverted first implementation
coupled those requirements to parallel formats, release proofs and family
machinery. The reset provides one pure engine, transactional run stores and
ordinary run admission. The owner accepted these choices on 2026-10-10, with slot handoff and the
pinned-parent archive warning. The plan defines the authorized delivery order.

## Decision

1. A Call Workflow invocation waits for one independently accepted child run in
   the same workspace. Publication pins an exact immutable child version and
   validates the bounded dependency closure. Recursion across workflow identity
   is rejected even through a different version. First delivery supports only
   bounded inline JSON inputs/results and wait-for-result calls through the
   existing Manual/Webhook JSON entries. Schedule-entry calls need an explicit
   later contract; parent triggers remain unrestricted.
2. Publishing requires current authoring/read authority for parent and child;
   starting requires current `run:start`. A later spawn belongs to that accepted
   execution. Access revocation prevents new starts/publications without making
   accepted runs depend on a retained user session. Archive prevents fresh child
   acceptance; already accepted children continue. Pins preserve immutable data,
   not an exemption from lifecycle rules. Before archive, the editor warns and
   lists the published parents that pin the target workflow.
3. Waiting releases the worker job and hands the parent's workspace active-run
   slot to its child. The parent dispatches no ordinary work while lending it;
   terminal child settlement returns the same slot to a live parent before it
   resumes. Nested calls transfer it down their direct chain; parallel Call
   intents use it serially in stable order. Capacity one and the default five
   therefore support calls without extra workspace capacity or capacity
   failures. Child workflow concurrency/FIFO still applies and may refuse the
   Call without creating an unreserved queued child. Preserve parent
   continuation rights, count each workspace slot once, and release it exactly
   once after canceled/terminal borrowers settle. No family quota or new role.
4. Workspace, parent run and scoped invocation key identify one immutable spawn
   intent and one accepted child or refusal. Recovery resolves that identity
   before fresh admission checks. A replayed parent has a new run identity. The
   normal request-receipt expiry cannot permit a duplicate spawn.
5. The pure engine declares the wait/intent. Execution owns child run actions;
   database TypeScript owns intent, acceptance, reservation, call binding and
   outbox transactions. Existing maintenance authority performs admission and slot transfer;
   there is no new role, public child-start endpoint, SQL writer fence or queue
   protocol. Intent and spawn are separate durable transactions. Child terminal
   facts and parent wakeups commit together; parent consumption uses its CAS.
6. Inherit the parent's absolute deadline when present; a configured shorter
   deadline may narrow it once. Preserve ordinary usage and notification policy
   per run. Child unknown outcomes propagate to a still-live required Call and
   parent; late completions cannot change a terminal parent. Parent close
   records direct-child control intents rather than holding several run locks
   together.
7. Retain facts and pins needed by live parents. Retire input/result detail with
   normal run retention; retain only the spawn identity/status needed by the
   parent recovery/history window. History distinguishes expired detail and
   authorizes each run independently. The first schema slice must prove the FK
   and retirement representation with ordinary retention and workspace purge.
8. Prune finished loop state before proposing larger limits. Keep current bounds
   and the checkpoint byte cap until recovery, late/conflicting facts,
   downstream mappings and actual PostgreSQL rewrite measurements prove bounded
   active state. No numbered replacement format or automatic return to old
   limits.

## Consequences

The child uses ordinary run execution and history, and duplicates recover one
recorded outcome. Calls retain their parent's workspace slot across wait, child
execution and return, including under saturation and lowered limits. Admission
SQL/counters and dispatcher recovery must distinguish lenders from the current
execution owner; this is not achieved by removing a reservation alone. An
archived target can still fail fresh acceptance; the editor warns before archive
and lists affected published parents.
Inline-only contracts exclude artifact-valued calls initially. Short-lived
transactions avoid parent/child lock coupling, but require explicit crash and
opposing-writer tests. Retention must preserve spawn identity without retaining
entire run families indefinitely.

The plan defines delivery slices and evidence. The owner accepted the plan and
this ADR; the reset follow-up precedes slice 1 pruning. No F08 runtime code or
checkpoint pruning accompanies this decision commit.

## 2026-10-15: human-wait execution clocks

[ADR 076](076-durable-human-tasks.md) distinguishes the inherited absolute
wall deadline from a run's pausable execution budget. Absolute deadlines never
extend. Human quiescence pauses the execution budgets of accepted descendants;
unstarted sibling Calls retain their remaining recorded budget across the same
parent pause. An already expired Call is never revived, and retry still cannot
reset a deadline. Target/version/input identity and ordinary Call handoff remain
unchanged.

## 2026-10-17: measured loop limit increase

The owner authorized F08 slice 5. Set each loop's item limit to 4,998, total
run loop iterations to 5,000 and expanded invocations to 5,000, including weighted
Call dependencies. Keep static nodes (200), identifier length (64), loop
concurrency (200), workspace/run/worker capacity and all value/checkpoint bounds.

Pruning limits retired history, not the live frontier. A model-owned publication
check keeps conservative concurrent expansion at 200: multiply nested body
counts by each loop's `maxConcurrency` and sum ordinary nodes. A wider graph is
rejected with a request to lower Items at a time; every previously legal graph
under the 200 total-expansion bound remains legal. This does not change stored
formats, accepted-run budgets, admission, slot handoff or recovery.

The maximum nested, parallel, Call and out-of-order measurements and their
PostgreSQL write-volume scope are recorded in the [F08 plan](../feature-plans/08-subworkflows.md#slice-5-measured-loop-limits-2026-10-17).
Eight maximum-size cases each execute 5,000 weighted invocations in the engine/
PostgreSQL checkpoint-write fixture. Peak checkpoint size is 186,426 of 262,144
bytes; measured checkpoint WAL ranges from about 5.2 to 54.8 MB. These are
checkpoint costs, not full run transaction WAL. Real workers finish short runs
in the same and another workspace in roughly 4–10 seconds while maximum loops
are active, then settle cancel/deadline and release admissions. Exact inputs,
write counts, settings and scope are in the plan.

Maximum total work remains useful with bounded concurrency; count-only increases
without this check overflow the existing 256 KiB checkpoint. Batching processes
a whole bounded batch in each body operation. It does not reset run budgets or
increase JSON limits; Call children still serialize through slot handoff.
This amendment supersedes the unchanged-200 limit statements in ADR 020's
pruning amendment; its loop identity, budget and durability rules still apply.

Qualification also corrects ready-delivery control settlement: an already
admitted attempt can acquire its fenced lease after cancellation/deadline
activation so the existing handler records its control outcome before execution.
Rejecting that claim stranded running checkpoint invocations. The input-control
check, physical dispatch uncertainty, receipt idempotency and capacity ownership
remain unchanged; no new scanner or completion rule is introduced.

Run reads and their public response bounds use the model-owned expanded limit,
so maximum runs remain inspectable. History lists page 50 entries locally;
graph statuses and inspection retain the complete bounded snapshot. No new read
endpoint, stored format or server pagination mechanism is introduced.
