# Worker coordinator integration and fixture review

Date: 2026-09-12. Primary reviewer fully read all 15 inventory files below.
These suites were not run: setup migrates disposable databases but also clears
fixed Redis queues and several scenarios stop shared Compose services. Review
cross-checked producer job IDs/retention, the integration runner's serial-file
configuration and the actual harness call sites. It is not deployed evidence.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `apps/worker/test/coordinator-consumer.fixtures.ts` | FIX/REFACTOR WQ-118–WQ-119 | Unique generated PostgreSQL database and chronological compatibility activation are good. Import-time pools, fixed Redis DB 12, broad exports, unowned migration child and failure-skippable cleanup obscure ownership. apiQuery currently uses max=1, so do not claim ordinary successful queries arbitrarily switch connections. |
| `apps/worker/test/support/coordinator-dispatch-fixtures.ts` | KEEP; REFACTOR WQ-118–WQ-119 | Actual ready consumer determines allowed jobs; notification and coordinator policies remain distinct. Eager nested acquisition lacks rollback; numeric aggregate claims do not identify target events. |
| `apps/worker/test/support/coordinator-recovery-harness.ts` | FIX/TEST WQ-117–WQ-118 | Useful intent-level execute/continue/restart interface and explicit job-failure diagnostics. redeliverAttempt only republishes retained IDs; repeated publishCoordinator can observe old completion. Initial queue acquisitions and close/restart errors are incompletely owned. |
| `apps/worker/test/support/coordinator-run-fixtures.ts` | KEEP; FIX/REFACTOR WQ-118–WQ-119 | Correct redelivery helper removes completed job and waits for new completion; replay uses actual database interface and preserves lineage. Acquisitions before cleanup, optional captured job ID fallback and unrelated notification seeding in the same module impede locality. |
| `apps/worker/test/support/coordinator-workflow-fixtures.ts` | KEEP; REFACTOR WQ-119 | Explicit graph fixtures show branch selection, iteration budget and nested caps; executable compilation validates current graphs. Retained fixture intentionally bypasses recompilation to exercise compatibility. Tuple edge typing and retained JSON validation could improve failure diagnostics. |
| `apps/worker/test/support/workspace-query.ts` | KEEP | One checked-out client owns BEGIN, transaction-local tenant setting, statement and COMMIT; rollback preserves primary error and finally releases client. The pool belongs to caller, so checkout-before-try here does not leak an internally owned pool. |
| `apps/worker/test/support/disposable-database.ts` | KEEP; CONDITIONAL WQ-118 | Safely quotes identifier, parameterizes activity lookup and refuses forced termination. Attempt count with pg_sleep is not a wall-clock bound; check-versus-drop race can reject safely. Same helper duplication as API merits one owned test utility, not production lifecycle machinery. |
| `apps/worker/test/for-each-worker-process-fixture.ts` | FIX/TEST WQ-118 | Uses actual coordinator/node runtimes and signals readiness after both consumers. Second startup/readiness failure leaves earlier resources unowned; SIGTERM handlers install only after readiness; ignored close failures always exit zero. |
| `apps/worker/test/coordinator-consumer-identity-mismatch.integration.test.ts` | KEEP; TEST WQ-118–WQ-119 | Forged run payload checks unchanged checkpoint/events/nodes/receipt plus durable security audit. Add authoritative run unchanged and exact audit identity/reason; cleanup/queue isolation need shared fixture repair. |
| `apps/worker/test/coordinator-consumer-linear-execution.integration.test.ts` | KEEP; FIX/REFACTOR WQ-118–WQ-119 | Strong exact events, outputs, attempt IDs, retained release and checkpoint evidence. Actually removes completed jobs before replay. Inner coordinator queue is closed only on successful wait; repeated execution choreography can use the repaired harness without hiding expectations. |
| `apps/worker/test/coordinator-consumer-redelivery.integration.test.ts` | KEEP; TEST WQ-118–WQ-119 | Distinguishes initial duplicate handling, replay lineage and fresh-worker terminal output with unchanged source snapshot. First two use correct redelivery harness; do not conflate them with WQ-117. Shared fixture lifecycle remains a dependency. |
| `apps/worker/test/coordinator-consumer-parallel-recovery.integration.test.ts` | KEEP; TEST WQ-117–WQ-119 | Per-iteration admission counts and durable loop/join facts are valuable. Same-ID republishing does not ensure second handler execution; mocks recreated on resolve cannot be asserted afterward. Redis deletion after graceful worker closure proves state reconstruction, not every crash boundary. |
| `apps/worker/test/coordinator-consumer-foreach-cancellation.integration.test.ts` | KEEP; FIX/TEST WQ-118–WQ-119 | Explicit body output/ordinal facts, budget reservation and cancellation-before-next-batch are meaningful. Child startup failure can leak process, signal exit can confuse stop and stop has no deadline. Two boolean-driven scenarios share a substantial prefix but need separately reported outcomes. |
| `apps/worker/test/coordinator-consumer-retry-wait.integration.test.ts` | KEEP; TEST/FIX WQ-118–WQ-119 | Actual due scanner, unavailable Redis, durable wakeups and stable provider-key reuse are exercised with injected engine. A 500 ms due timestamp is created before lengthy setup, so the 150 ms pre-due observation can already be overdue. afterClaim ownership starts too late. |
| `apps/worker/test/coordinator-consumer-failure-notification.integration.test.ts` | KEEP; FIX/TEST WQ-118–WQ-119 | Separates pre-fence DB loss, post-fence Slack uncertainty and email-key retry; proves notification cannot alter failed-run truth. Fresh credential buffers are correct. Unbounded allEntered and unprotected provider runtime acquisition can strand tasks; privacy query checks email facts while claiming Slack literals too. |

## WQ-117 — prove handler redelivery separately from queue deduplication

P2 TEST/FIX. `support/coordinator-recovery-harness.ts:129–168,257–283`;
`coordinator-consumer-parallel-recovery.integration.test.ts:55–61,157–165`.

The producer derives `outbox-${outboxEventId}` and retains completed coordinator
and attempt jobs (`packages/queue/src/producer.ts:134–147,168–177` and
`defaults.ts:42–68`). The harness redeliverAttempt calls publish again without
removing the completed job, waiting for a new delivery or counting handler
entries. Calling publishCoordinator twice with identical revision likewise can
immediately observe the original completed job and existing checkpoint. BullMQ
documents that adding an existing job ID is ignored; removing the existing job
permits the ID to be added again. [Official job-ID contract](https://docs.bullmq.io/guide/jobs/job-ids).

This is a source-verified evidence gap, not a claim that PostgreSQL duplicate
handling is broken. The separate createCoordinatorRedeliveryHarness and linear
execution test already remove jobs before republishing; retain that evidence.

Plan: expose an explicit redelivery operation in the existing recovery harness.
Wait for original handler completion, remove only its exact owned job, republish
the exact durable delivery identity and wait for a new handler entry/completion.
Keep a distinct same-ID publish test if queue deduplication is itself desired.
Do not change the outbox ID or clear the inbox to manufacture a different
logical message. Observe the handler seam or a delivery-only counter, not a
new durable side effect that the duplicate path is supposed to suppress.

Acceptance: known handler entry count increments from one to two while attempt,
event, checkpoint revision, usage and provider effect counts remain unchanged;
malformed identity still fails, valid source lineage retained. Restart must not
erase a just-enqueued duplicate before the test observes it. In the current
parallel test redeliverAttempt is immediately followed by restart/obliteration,
so a publish success alone is especially insufficient.

## WQ-118 — make recovery test ownership survive failure and process exit

P1/P2 FIX/TEST; integrate WQ-115 rather than invent another cleanup framework.

### Fixture and runtime owners

- `coordinator-consumer.fixtures.ts:132–145,159–184,332–401`: create fixture
  pools during setup with immediate cleanup registration. Handle migration child
  error as well as exit, bound its lifetime and await termination after timeout.
  An async beforeAll failure must still leave a complete partial-owner record.
  Use fileURLToPath for paths rather than URL.pathname (escaped spaces matter).
- Preserve generated database-name grammar and inspect-before-drop. Remove no
  arbitrary database, terminate no other client and never force-drop to avoid
  fixing open handles. Put pool ownership around drop's connect/query stages.
  If an actual total teardown bound is required, bound SQL operations too: 500
  iterations of pg_sleep(0.02) do not bound a hung activity query.
- Fixed Redis DB 12 and force-oblitera­tion require positive proof of an isolated
  namespace and exact endpoint/project ownership. PostgreSQL isolation does not
  isolate Redis or authorize stopping its host service. Existing serial file
  execution prevents one supported-suite overlap, not independent runs.
- `cleanupFixture:379–401`: a failure closing the first queue or second queue
  can skip apiDatabase, both pools and database drop. All afterAll hooks also
  await restoreServices before cleanup; failed restore prevents cleanup. Own
  each stage, attempt independent closes, aggregate errors and keep restoration
  failure visible. Don't invoke restoreServices for ordinary scenarios that
  never changed a service unless it is an explicit fixture requirement.
- Recovery and redelivery factories acquire multiple owners before a protected
  try. Keep existing partial-start catch logic in recovery.startWorkers but add
  earlier producer/queue acquisitions to it. restart must not start new workers
  when prior close failures were ignored or keep stale closed references as the
  active owner. close needs one shared completion promise; setting workers to
  undefined before close finishes is not evidence it completed.
- Linear test's inner coordinatorQueue (created after initial publish) needs a
  local finally. Retry/Wait afterClaim is created and awaited through several
  failure points before entering the final dispatcher try. Notification
  providerStore/runtime/dispatcher are also acquired before their protected
  scope. Register these immediately; preserve consumer-before-dependency drain
  order where capabilities are shared.

### Process and blocked-work owners

`coordinator-consumer-foreach-cancellation.integration.test.ts:45–109` and
`for-each-worker-process-fixture.ts:16–61`:

1. Parent startWorkers owns its child from spawn, not only after readiness.
   Timeout, spawn error, early exit or invalid readiness must terminate/await it
   and dispose listeners/timers. Bound stdout/stderr; parse a framed readiness
   message rather than an arbitrary substring. A child must not survive a
   rejected startup promise merely because assignment never happened.
2. stopWorkers checks exitCode only. A signal-terminated child can have null
   exitCode with non-null signalCode, so awaiting a future exit after it already
   exited can hang. Track one exit promise from spawn and await that; install
   listeners before triggering termination. Bound graceful stop and report
   forced termination truthfully. Never signal a guessed/reused PID.
3. The fixture child needs protected partial startup and signal ownership before
   readiness. Close both owners even if one throws; return nonzero on actual
   shutdown failure instead of ignoring allSettled and calling process.exit(0).
4. `failure-notification...:373–494`: blockedResults are started, but allEntered
   has no deadline or rejection path. If one deliver resolves/rejects before its
   provider entry, the other may wait for an abort that never happens. Install
   rejection observation when each task starts; finally abort every controller
   and await all results even when the barrier/assertion fails. Keep distinct
   before-dispatch versus possibly-dispatched outcomes.

Acceptance: injected partial construction, startup rejection/timeout, prior
signal exit, child ignoring SIGTERM, stream output overflow, blocked provider
failure, rejected first cleanup and failed service restore; no unobserved task,
child or pool remains. Original failure plus cleanup evidence retained, exact
private targets verified. These harness unit tests need no real service outage.

## WQ-119 — concentrate fixture mechanics without hiding domain assertions

P2 REFACTOR/TEST and conditional timing improvements.

- `coordinator-consumer.fixtures.ts:403–500` reexports Node, pg, queue, engine,
  registry and runtime symbols alongside global fixture state. Tests importing
  randomUUID/Pool through it gain hidden import-time ownership. Import libraries
  directly; give the fixture one small instance interface for its generated
  identities, connections, role-scoped queries, setup and close. Dependencies
  vary at SQL/Redis/child seams; no application-wide DI rewrite is needed.
- Keep `queryAsWorkspaceRole`: it centralizes a real transaction invariant.
  Replace apiQuery's sequence of pool.query calls with that same checked-out
  client pattern for consistency and future safety, but state that current
  max=1 and private pool make the successful present path coherent. Preserve
  tenant-local setting, role semantics and primary rollback error.
- `support/coordinator-run-fixtures.ts:61–160`: after guarding published,
  capture its jobId in a local constant rather than optional chaining plus an
  empty-string fallback inside callbacks. Separate failure-notification setup
  (terminalizeFailedRun) from run acceptance only if the split removes imports
  and unrelated concepts; keep its durable commitAdvancePlan assertions.
- `support/coordinator-workflow-fixtures.ts`: graph fixtures are useful explicit
  data, not bad code because they are long. Give edge tuples a fixed-length
  readonly type or small named edge constructor so destructuring cannot silently
  produce undefined values. Validate retained JSON at the retained-executable
  seam; do not regenerate it with today's compiler. Promise.all seeding is
  independent but all queries use the same max=1 owner pool; serial seeding is
  a clarity option, not a claimed performance fix.
- `coordinator-consumer-retry-wait.integration.test.ts:78,289–327`: dueAt is
  set 500 ms ahead before DB inserts, transaction seeding and runtime startup.
  The later 150 ms negative observation may be after dueAt on loaded CI. Arm
  a comfortably future database timestamp after setup, prove the observation
  stayed before it, then transition the owned fixture due time for the positive
  scan. Keep one real database-clock contract test. This suite injects
  retryEngine and seeds idempotent behavior onto a core manual node; document
  it as scanner/transport/persistence proof, not end-to-end production retry
  policy or actual Wait executor evidence. Use named retry/wait fixture records
  instead of parallel arrays and firstAttemptIds[1] as string.
- For Each runFixture(false/true) combines terminal success and cancellation in
  one reported test. Reuse a named prefix-to-batch checkpoint and report two
  scenarios, keeping all ordinal/budget/output assertions visible. Do not erase
  canonical ordering or real restart steps to reduce line count.
- Parallel tests create fresh vi.fn inside capability factories, losing a
  stable spy reference. Use one spy per capability and assert no call after the
  terminal/target state. Existing runtime rejects accidental calls, but explicit
  counters improve diagnostics. Don't claim graceful restart equals SIGKILL.
- Identity mismatch should compare both target and authoritative run snapshots
  and assert audit reason/identity, not only count. Notification privacy evidence
  currently selects email intent audit/outbox and email run events while the
  forbidden regex includes Slack token/channel. Query both intents/runs before
  asserting both providers' sensitive values are absent. Credentials are fake
  and fresh on each open; retain those properties.
- Narrow claim waits to exact owned IDs when a test promises a particular event.
  Keep cumulative fair-round helpers for their actual total-count use, with
  valid batch sizes and useful stage diagnostics. A numeric count alone is not
  proof of delivery identity.

Order: isolation/ownership first, actual redelivery evidence next, clock/barrier
validity and assertion scope next, then fixture imports/naming/locality. Do not
change production replay, RLS, state-machine or compatibility contracts to make
tests easier. No source changes, service execution, commit or push occurred.
