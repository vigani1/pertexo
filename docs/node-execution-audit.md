# Node execution audit — 2026-09-27

## Scope and verdict

Review of all shipped node families, their executor contracts, control-node
composition, and durable execution. This is a review of the current dirty
working tree, not a claim about a committed release. No implementation changes
were made by the reviewer during this audit.

**Correction in progress, not independently closed:** the N1–N3 reviewer
reproducer now reaches terminal success and N4's continuation decision is
engine-owned. The connected matrix and independent review below are still
required before declaring all four findings closed. Passing individual
executor tests did not detect these composition defects.

The durable PostgreSQL outbox is necessary, not a workaround. ADR 006 requires
checkpoint changes and their delivery intents to commit atomically. The new
`persistDerivedContinuation` heuristic, however, puts an engine scheduling
decision into the database adapter. Keep durable delivery; replace inference
from event names with an explicit engine-owned decision or bounded internal
settlement. Do not add polling or further per-node database special cases.

## Findings

### N1 — P1: Condition inside For Each can leave a run waiting forever

- Accepted graph: outer For Each with a single-sink body `Condition → Set`,
  connected through the selected `true` output. All attempts succeed.
- Actual result: loop retains active ordinal 0, run is `waiting`, no next
  attempt or continuation-triggering event is produced.
- `packages/workflow-engine/src/coordinator-observations.ts:315` reconstructs
  the sink key using only the enclosing loop branch path. The actual Set
  invocation also contains the Condition selection in its branch path.
- `packages/workflow-engine/src/workflow-transition-observations.ts:246`
  repeats the incomplete reconstruction when applying completion.
- Fix both derivation and application: identify the actual scoped sink
  invocation, preserve iteration and inherited branch identity, and propagate
  that exact identity. Do not select an arbitrary node with a matching node ID.
- Required regressions: Condition and Switch selected/skipped paths, inherited
  plus local branch scopes, multiple iterations, restart/redelivery, and
  cancellation. Exercise valid Parallel/Merge combinations in loop bodies too.

### N2 — P1: Nested For Each as the sole outer sink corrupts advancement

- Accepted graph: outer For Each body contains only an inner For Each; inner
  body contains Set. Existing nested fixtures add an ordinary outer sink after
  the inner loop and therefore do not cover this shape.
- On the inner declaration's successful attempt outcome, `advanceWorkflow`
  throws `checkpoint_invalid: loop parent invocation is inconsistent`.
- `coordinator-observations.ts:332` treats the inner declaration outcome as
  completed outer sink execution. `operations.ts:191` derives it before the
  declaration outcome is filtered from ordinary execution observations.
  `workflow-transition-observations.ts:278` then marks an active control node
  terminal before its nested body has settled.
- Distinguish declaration completion from control completion. Filtering the
  first outcome alone is insufficient: later derived inner-loop settlement
  must be recognized as the outer iteration's completion.
- Required regressions: nonempty/empty inner collections, failures, disabled
  controls/body, cancellation/deadline, multiple outer iterations, and restart
  after inner settlement. No unconditional extra coordinator deliveries.

### N3 — P2: Run reports waiting while new node attempts are running

- Reproduced with nested loops followed by an ordinary sink, and an entirely
  disabled loop body followed by Terminate.
- After entering `waiting`, the engine admits a new attempt and sets its
  invocation to `running`, but leaves checkpoint `runStatus` as `waiting`.
- `workflow-transition-plan.ts:73` admits work; its status derivation handles
  running-to-waiting but not this reverse transition. Timer resumption has a
  separate reverse transition that does not cover derived control settlement.
- Restore truthful run status when work is admitted/active, while preserving
  genuine waits, cancellation and terminal states. Follow the existing event
  vocabulary rather than inventing a duplicate lifecycle mechanism.
- Assert checkpoint and persisted run/API status, not just final success.

### N4 — P2: Database infers immediate engine work from event names

- `packages/database/src/execution/coordinator-run-store-run-transition.ts:32`
  requests another pass when a nonterminal plan has no attempts and includes
  `node.succeeded` or `node.skipped`.
- This repairs the demonstrated serial-loop wakeup loss, but couples database
  persistence to control-node scheduling semantics. It does not repair N1/N2.
- Preferred small seam: an explicit, validated immediate-continuation decision
  on the engine transition plan; database persists it in the same CAS/receipt
  transaction. A bounded engine-local fixed-point settlement is also acceptable
  if it preserves budgets and avoids needing another delivery for internal work.
- Derive the decision from actual unsettled scheduler work, not by moving the
  same event-name test to another file. No endless no-change wakeups, no
  immediate wakeups for genuine future timers, and no terminal continuation.
- Keep transition fingerprints/validation compatible with the changed plan.
  Preserve receipt idempotency: redelivery must not append a second intent.
- Preserve the existing serial-loop regression including worker restart and
  isolated Redis loss. A driver must advance only from admitted attempt
  outcomes, returned continuation intent, or due timers—not an unconditional
  repeated empty engine pass.

## Node inventory and evidence

All 15 families (21 versioned definitions) were included in the executor,
registry, schema and provider-boundary review:

| Family | Versions | Package-level checks |
| --- | --- | --- |
| Manual | 1, deprecated placement | Passthrough, abort, retained execution |
| Set | 1 | Resolved values, bounds, invalid inputs |
| Terminate | 1 | Terminal-success executor contract |
| Condition | 1 | Strict boolean routing |
| Switch | 1 | Ordered selection/default, port/config bounds |
| Parallel | 1–3 | Branch order, concurrency, retained/current registry |
| Merge | 1–3 | Selection/ledger contracts and dispositions |
| For Each | 1 | Owned bounded collection declaration |
| Wait | 1 | Bounded duration and passthrough |
| Webhook | 1 | Registry passthrough and separate ingress coverage |
| Schedule | 1–3 | Retained cron contract and stricter current versions |
| Validate | 1 | Rules, missing/null, limits, cancellation, preview parity |
| HTTP Request | 1 | SSRF/DNS, credentials, bounds, redaction, ambiguous effects |
| Slack Send Message | 1 | Dispatch fence, retry/unknown-outcome classification |
| Email Send Notification | 1 | Stable idempotency/payload binding, credentials, retries |

Core executors intentionally do not orchestrate children or sleep through Wait.
The coordinator and durable timer/attempt stores own those responsibilities.
That separation itself is correct. No separate provider-adapter defect was
confirmed in this audit.

### Fresh passing evidence

- `pnpm --filter @pertexo/nodes-core --filter @pertexo/node-catalog --filter
  @pertexo/node-sdk --filter @pertexo/integrations test`: 637 tests / 33 files.
- `pnpm --filter @pertexo/workflow-engine test`: 377 tests / 32 files.
- `WORKER_TRANSPORT_INTEGRATION=true pnpm --filter @pertexo/worker
  test:integration` with the six explicit coordinator files for linear
  execution, retry/wait, redelivery, parallel recovery, identity mismatch and
  foreach/cancellation: 10 tests / 6 files. Real disposable PostgreSQL and
  isolated Redis namespaces; includes the serial-loop restart/redelivery test.
- Provider-worker integration: 16 tests / 1 file passed using
  `http-node-attempt.integration.test.ts`, both integration flags enabled and
  the local artifact-store values from `.env.example`. Real disposable
  PostgreSQL/Redis/S3-compatible storage; HTTP/Slack/Email dispatch simulated.
- Database trigger integration: 36 tests / 6 files passed: schedule-triggers,
  schedule-triggers-part-2, schedule-misfire, schedule-claim-concurrency,
  webhook-triggers and webhook-trigger-prior-head.
- `WORKER_TRIGGER_INTEGRATION=true pnpm --filter @pertexo/worker
  test:integration test/schedule-trigger.integration.test.ts`: 1 test passed.
- Total fresh existing-suite evidence: **1,077 passing tests**. The separate
  reviewer harness still reproduces N1–N3; passing suites do not close them.

### Additional reviewer reproduction

Temporary harness: `/tmp/pertexo-control-audit.g60Y2j/repro.mts`.
Run from the repository: `pnpm exec tsx /tmp/pertexo-control-audit.g60Y2j/repro.mts`.
The implementation chat must convert the relevant cases to repository-owned
regressions; this temporary file is not a permanent test dependency.

It uses production executable compilation, `advanceWorkflow`, and the real
For Each-active registry release, supplying simulated successful persisted
attempt facts. N1 and N2 compile successfully before failing at advancement.
The main reviewer independently reran the harness and observed both failures
and the N3 status mismatch.

Other harness cases reached success: ordinary/empty loops, disabled body,
nested loop with ordinary sink, root Condition/Switch selected and unselected
paths, paired Parallel/Merge at serial concurrency, disabled node chain and
disabled Parallel. Some successful paths still expose N3.

### Limits

- No real Slack/Resend delivery, external credentials/KMS, or production
  deployment was exercised. Provider fixtures are not production proof.
- No claim that every possible graph combination is covered. Add the listed
  composition cases before closing the findings.
- Shared-service outage tests that stop PostgreSQL/Redis were deliberately not
  run against the user's active development services.
- Browser behavior was not re-audited in this node-runtime pass. N3 requires
  persisted/API status verification and an appropriate UI check after fixing.
- Existing dirty work, including CONTEXT and the notifications plan, must stay
  intact. No commit, push, merge, external messages or destructive reset is
  authorized by this audit.

## Implementation and closure contract

### Current correction evidence

- N1: `scopedLoopSinkInvocation` identifies the single sink by node, exact
  iteration path and inherited branch prefix. Coordinator derivation carries
  that invocation key into completion; application and checkpoint validation
  use the same scoped identity. The original Condition-in-For-Each reproducer
  now settles. Permanent engine tests cover selected/skipped Condition and
  Switch paths, two iterations, and inherited plus body-local branch scopes.
- N2: a fresh inner For Each declaration is not treated as the outer sink's
  terminal outcome. A later terminal inner control invocation closes the outer
  iteration. The original sole-sink nested reproducer now settles; permanent
  tests cover nonempty and empty inner collections, inner-body failure,
  cancellation and deadline expiry. Disabled ordinary bodies and a disabled
  inner sole-sink control also settle without invented child attempts.
  Existing nested-with-ordinary-sink and retained V1 synthetic-loop tests
  remain green.
- N3: admission from `waiting` restores checkpoint `running` before the plan
  is committed. The permanent driver asserts this for every admitted attempt
  in its compositions. A disposable-PostgreSQL integration test commits a
  waiting-to-running plan and checks both the persisted checkpoint and
  `workflow_runs` row. A separate disposable-PostgreSQL/Nest integration
  reads the same authenticated run through the real GET run endpoint while
  its row changes from waiting to running (the test sets those two row states;
  the coordinator transition is proved separately). A React component
  regression confirms a Query refresh changes the visible run heading and
  step status from waiting to running using an MSW response.
- N4: the engine transition plan now carries `immediateContinuation` only
  when scoped scheduler readiness or a terminal active-loop sink requires
  another pass without an admitted attempt. The database validates the plan
  field and persists its outbox intent inside the checkpoint CAS transaction;
  it no longer infers control work from event names. The serial-loop worker
  integration passed with restart, isolated Redis loss and redelivery receipt
  deduplication. The same disposable worker fixture now also runs Condition,
  Switch and nested sole-sink For Each bodies through fresh worker processes,
  persisted outbox continuation, duplicate coordinator delivery and final
  successor execution. It checks each child's branch/iteration scope, one
  attempt per child, unchanged checkpoint revision/outbox on redelivery and a
  single completed inbox receipt. The nested driver consumes an additional
  persisted engine continuation when needed; it never supplies an unconditional
  empty pass. Production wait tests assert a future timer and a no-change
  pre-due pass do not request an immediate continuation.

Executed after the correction: workflow-engine 391/391 unit tests (33 files),
including 14/14 structured-control tests; database 791/791 unit tests (115
files); worker 803/803 unit tests (65 files);
disposable PostgreSQL coordinator integration 10/10 (For Each and commit-output
files) plus a separate 1/1 persisted-status integration; worker serial-loop
integration 1/1 with disposable PostgreSQL and isolated Redis namespace, now
also exercising the three structured shapes above. The authenticated HTTP
status-read integration passed 1/1 (7 filtered), and the mocked React status
regression passed 1/1 (8 filtered). Engine, database, worker and web typechecks
passed; the web production build and web lint passed; changed-file ESLint and
the repository architecture check passed, as did
`git diff --check`. The original temporary reproducer was rerun and its N1/N2
cases reached success;
N3 now reports `running` when attempts are admitted. These are local runtime
and controlled integration checks, not production provider evidence.

Remaining before closure: independent reviewer re-verification and any broader
real-browser or live-provider checks required for release. The HTTP check is a
real authenticated API/disposable-database read, but the browser status check
is component-level MSW coverage, not a live end-to-end journey. A paired
Parallel/Merge body, inner-body failure, cancellation and deadline expiry have
focused engine regressions. This paragraph does not mark the slice complete.

The existing **Review apps web codebase** chat
(`01a0a09e-2fed-7061-99c2-e1a5412561e7`) implements; this chat reviews/manages.
Implement N1–N4 as one coherent engine/persistence correction, with focused
regressions showing the pre-fix failures. Do not broaden into node redesigns,
new features, migrations, or speculative generic abstractions.

Before reporting completion: supply exact changed files, red/green evidence,
engine/database/worker test commands and counts, typecheck/lint results, and
explain continuation ownership, restart/redelivery, branch/iteration identity,
and control declaration versus settlement. List any remaining limitation.
The reviewer must inspect the actual diff and independently rerun critical
cases before marking these findings closed.

### Independent local closure review — 2026-09-27

N1–N4 are **verified for the audited local correction scope**. The reviewer
inspected the engine/coordinator persistence diff, new graph fixtures, worker
restart/receipt assertions and the separate status tests against HEAD
`9e39c8d0`. No blocking correctness or specification finding remained.

Independent reruns:

- `pnpm --filter @pertexo/workflow-engine test`: 391/391 passed, 33 files.
- `pnpm exec tsx /tmp/pertexo-control-audit.g60Y2j/repro.mts`: original nested
  sole-sink and Condition-in-loop cases settled; admitted attempts report
  running. Permanent repository tests, not this temporary harness, own the
  regression coverage.
- `WORKER_TRANSPORT_INTEGRATION=true pnpm --filter @pertexo/worker
  test:integration test/coordinator-consumer-foreach-cancellation.integration.test.ts`:
  1/1 passed, 36.71 seconds, including serial, Condition, Switch and nested
  sole-sink journeys. Fixture-created disposable database and isolated Redis
  test namespace only; shared services were not stopped.
- A separate spec reviewer reran the structured-control and executable-control
  files: 20/20 passed (overlaps the 391, not an additional unique count).

Standards review found no hard violation. One nonblocking cleanup remains:
new terminal-status lists in `coordinator-observations.ts` and
`workflow-transition-plan.ts` repeat `isTerminalNodeStatus` from
`workflow-transition-state.ts`. Reuse one typed predicate, retaining explicit
undefined handling, then rerun the engine checks. This is not a runtime defect.

Evidence limits: worker processes restart gracefully at persisted boundaries;
the harness manually publishes identifiers from durable outbox rows, rather
than running the production outbox relay. It does not prove every mid-write
crash window. HTTP status was verified by the implementer through a real
authenticated read after seeded state changes; the UI assertion uses MSW,
not a live browser journey. No real-provider or production-readiness claim is
made. Broader release validation remains separate from closing these four
specific findings. The database cleanup gate may now open, with this small
predicate cleanup included before that batch. All work remains uncommitted.
