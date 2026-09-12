# Worker preview integration and crash-evidence review

Date: 2026-09-12. Primary reviewer fully read nine inventory files below.
Service-dependent suites were inspected only. One actual-source process-helper
probe used a transpiled module with injected child/timer/Vitest adapters: no
child process, database, queue or provider was started.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `apps/worker/test/support/preview-consumer.integration.support.ts` | KEEP; FIX/REFACTOR WQ-121–WQ-122 | Real migrations, forced-RLS effect ledger, compatibility activation and delivery completion checks add useful depth. Root hooks/global pools conceal setup ownership, fixed Redis DB 13 is not isolated across invocations, maintenance/coordinator queues are not removed, and generic wait lacks per-poll cancellation. |
| `apps/worker/test/support/preview-consumer-crash-process.support.ts` | FIX WQ-120 | Registers children immediately and has an afterAll kill fallback; retain that safety net. Evidence races leak timers/waiters, malformed stdout throws in event handler, spawn errors are unhandled and exit/kill has no bounded failure contract. |
| `apps/worker/test/preview-reconciliation-process-fixture.mjs` | KEEP; TEST/FIX WQ-121–WQ-122 | Explicit before-marker, after-marker, after-provider and after-outcome hang points use real durable operations. Synthetic provider effect is intentionally SQL, not actual remote delivery. Unvalidated input and partial runtime/store startup need ownership; impossible mode falls into an unhelpful timeout. |
| `apps/worker/test/preview-consumer-delivery.integration.test.ts` | KEEP; TEST WQ-121–WQ-122 | Removes exact completed job, waits for redelivery completion and compares full preview state/fence. Safe core.set legitimately has no dispatch marker. Add observable invoker count rather than assuming unchanged durable state proves no repeated computation. |
| `apps/worker/test/preview-consumer-reconciliation.integration.test.ts` | KEEP; FIX/TEST WQ-121–WQ-122 | Asserts unsafe expired lease becomes unknown with increased fence. Claim polling stops at any event, then assumes target is present; should accumulate exact owned target, respecting lease validity. Multiple acquisitions precede cleanup. |
| `apps/worker/test/preview-consumer-sigkill-reconciliation.integration.test.ts` | KEEP; FIX/TEST WQ-120–WQ-122 | Five explicit safety/dispatch/completion cases prove distinct durable reconciliation outcomes and pinned idempotency key. Child registry guards failed parallel setup. Event accumulation can retain expired claim tokens; acquisition/cleanup failures remain hidden. |
| `apps/worker/test/preview-consumer-crash-boundaries.integration.test.ts` | KEEP; FIX/REFACTOR WQ-120–WQ-122 | Four barriers assert queue active state, provider count, fence, terminal facts and exact stalled-job recovery. Case table should contain its repeated expectations; manual lock deletion is intentional and must remain scoped to owned job after verified child death. |
| `apps/worker/test/preview-consumer-artifact-retention.integration.test.ts` | KEEP; FIX/TEST WQ-121–WQ-122 | Real artifact capability, object verification and retention coordinator exercise a useful slice. The injected empty control ledger is not full control-ledger qualification; two-second setup deadline is fragile and most acquisitions/write/claim happen before cleanup protection. |
| `apps/worker/test/validate-preview.integration.test.ts` | KEEP; TEST/REFACTOR WQ-121–WQ-122 | Actual preview and workflow execution, restart redelivery and secret omission are useful. Expected values come from the same evaluator used in production, so add independent semantic assertions. A provider count for an unwritten key does not prove provider APIs were unused. |

## WQ-120 — own each child-evidence wait through every settlement path

P2 FIX/TEST. `support/preview-consumer-crash-process.support.ts:21–112`.
The source creates a new 15-second timer for each next() but never clears it
when evidence arrives or child exit wins. A timeout leaves its waiter in the
array; a future message matching that stale waiter is spliced and discarded
instead of being delivered to the current waiter. JSON.parse and predicate
evaluation execute outside containment in stdout's data listener.

Actual-source injected probe produced:

```text
retainedAfterSuccess = 1
malformedThrows = true
subsequentSettled = false
```

The probe resolved initial evidence, manually expired a second wait, installed
a third wait for the same predicate and emitted matching evidence. The stale
second waiter consumed it. The probe then emitted exit and awaited remaining
promises. Timers and child were inert injected adapters, not external resources.

Plan: each wait owns its timer and registration; one settle path removes both
on evidence, timeout, parse error, predicate error or exit. Handle child error
in the same terminal state as exit, while preserving its real cause. Parse
newline-delimited evidence into a checked object, cap pending-line, stderr,
queued-message and waiter sizes, and reject unsupported records with bounded
diagnostics. Do not log entire inherited environments/credentials. Use
fileURLToPath for executable paths. Keep the immediate active-child registry
and one exit promise; add bounded kill/exit error handling and report teardown
failure instead of ignoring allSettled.

Conceptual wait lifecycle:

```ts
const settle = (result: EvidenceResult) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  removeWaiter(waiter);
  complete(result);
};
```

This belongs inside the existing process helper, not a generalized messaging
framework. Acceptance: evidence before registration, split line, multiple lines,
malformed/oversize output, throwing predicate, timeout then late evidence,
spawn error, early exit, repeated kill and unsuccessful kill. Assert zero
outstanding timers/waiters after each settled request; later requests still
receive their messages. No real database process is necessary for these tests.

## WQ-121 — preserve private fixture resources and cleanup ordering

P1/P2 FIX/TEST; extensions of WQ-115/WQ-118.

- `preview-consumer.integration.support.ts:140–150,757–815`: make fixture
  ownership explicit at the calling describe/setup seam, not import-time pools
  and hidden root hooks. Guard configured execution deliberately. Track database
  creation and migrate-child lifetime; avoid the unnecessary force-drop of a
  freshly randomized name before CREATE. Scope cleanups to resources actually
  created, preserving inspect-before-drop and failed-cleanup evidence.
- clearNodeAttemptQueue only clears node-attempts. Reconciliation tests create
  maintenance jobs; Validate workflow creates coordinator jobs. Their completed
  jobs remain in Redis DB 13 after SQL database deletion. Track/remove every
  owned job or own an explicitly disposable isolated namespace. Do not broaden
  flush/obliterate against an unverified endpoint. Preserve serial suite config
  but test two independent fixture instances for namespace separation.
- Compatibility activation has real audit/probe semantics worth keeping.
  Register apiProbe before constructing workerProbe so second-constructor failure
  closes the first. Close failures must not be silently erased. The finite
  checked release history and monotonically advancing epochs are a valid
  termination argument; don't call the for(;;) an infinite-loop bug by itself.
- Delivery/Validate runtime creation makes store/invoker before runtime startup.
  Protect those owners if startup fails before transfer. In crash tests, producer
  readiness and dispatcher/runtime construction precede their final try. Keep
  the child registry fallback, but close each scenario's child locally when an
  assertion fails; do not wait for unrelated scenarios to finish.
- Artifact retention test creates capabilities/verifier, obtains an artifact
  handle, writes its body, claims/completes preview and constructs the retention
  coordinator before entering try at approximately line 136. Failure at any of
  those earlier awaits skips handle closure and cleanup of a known written
  object. Register owners immediately and update the owned artifact reference
  only after successful write; preserve original failure and report delete/
  close failures. Never delete an inferred object ID after an ambiguous write.
- Process fixture pool is protected at top level, but databaseStore and runtime
  acquisition in runComposedConsumer precede its try. Validate the finite mode
  and required identity fields before acquisition, and close a store whose
  runtime failed to construct. Deliberate hangAt is a crash-injection barrier,
  not an ordinary unbounded-production-work bug. SIGKILL intentionally bypasses
  finally; parent-owned recovery is the contract under test.

Acceptance: injected failure at every constructor/readiness/write/claim stage,
one close per owner, no queued job pointing to a deleted fixture database,
visible cleanup errors, no cross-fixture deletion. Only qualified private
environments may run artifact deletion, SQL mutation or child crash tests.

## WQ-122 — make preview scenario evidence independent and precise

P2 TEST/REFACTOR; some changes are conditional on the intended proof.

1. `preview-consumer-crash-boundaries.integration.test.ts:36–153`: cases already
   hold expectedDispatch/provider count/reconciliation status, but repeatedly
   derive attempt/run/audit/inbox expectations from mode string equality. Put
   expected barrier state/facts directly in each case or use one named
   terminalCommitted field. Keep each expected durable value visible; don't
   generate expectations with the same production reducer being tested. Avoid
   brittle cases.slice(0,3)/fixtures[3] if scenario order later changes: select
   by named phase/expected reconciliation behavior.
2. In both reconciliation matrix tests, claimed events are accumulated across
   multiple polling calls under five-second leases and only published when all
   targets have arrived. An early token can expire before the final event on
   slow CI. Either publish/mark each owned claimed event while its token is
   valid and separately wait for all outcomes, or retain/reacquire the claim
   through the existing lease contract. Check markPublished result. Never
   assume a Map of IDs retains authority indefinitely. Single-event test must
   poll for its target rather than any nonempty batch.
3. Existing tests pass overrides such as unsafe/provider-capable onto core.set
   to exercise database/handler classification. Label them as synthetic
   transport policy fixtures; they do not qualify actual provider registration
   or the preview real-adapter fence fixed under WQ-111. Add one real provider
   adapter scenario with current connection authority, without making external
   provider calls in ordinary unit tests.
4. `preview-consumer-artifact-retention.integration.test.ts:42–48,114–155`:
   two seconds includes capabilities startup, object upload, claim and complete.
   Loaded CI can expire the execution before the retention proof starts.
   Establish valid separate execution/retention timestamps with enough setup
   budget, then advance the owned fixture's retention state at the supported
   seam. Keep a real-clock quiescence test. The no-record ControlLedger mock
   is deliberate; title/evidence should say real retention coordinator plus
   artifact store with injected ledger, not full real-ledger reconciliation.
5. Validate test compares persisted output to evaluateCoreValidate output.
   That is a good transport-fidelity oracle, not an independent validator
   correctness oracle. Add fixed expected invalid rule IDs, valid=false and
   normalized public error fields for the mismatch; keep valid=true, exact
   persisted result and no-secret checks for matching input. Unit evaluator
   semantics remain owned by the core-node tests.
6. providerEffectCount('validate-preview') queries a key no real provider path
   in createValidateRuntime writes; zero is not evidence that provider methods
   were never invoked. Retain the SQL effect counter in the crash fixture where
   it is actually incremented. For Validate, capture invoker/capability-factory/
   resolve/write counters at the real seams and assert expected zero calls.
   Factories returning rejecting methods only fail if the method is called,
   not merely when a factory was called as the comment promises.
7. Preview delivery already removes the original job before republishing, so
   WQ-117 does not apply to it. Add an invoker count to distinguish no repeated
   computation from idempotent persistence; retain full state/fence comparison.
   Validate's restarted runtime is a fresh instance in the same process, not
   a new process: correct its comment, or use an actual process fixture only if
   the additional isolation is the stated contract.
8. Prefer parseStoredExecutionValueV1 over JSON.parse(String(output_ref)) at
   assertion sites. Current preview completion intentionally writes a serialized
   string inside JSONB, and the shared parser accepts that representation: this
   review does **not** call current String parsing a reproduced failure or alter
   persisted encoding casually. The shared parser makes accepted forms explicit.

Preserve complete crash-phase assertions, tenant-scoped queries, exact pinned
key and one logical attempt. Manual deletion of an owned stalled Bull lock is
an explicit fault-injection action after verified child death; don't copy that
technique into ordinary production recovery.

Order: child-evidence correctness and owner cleanup first, claim/time evidence
next, then narrower expected-state tables and shared assertion parsers. No source
edits, integration execution, commits or pushes occurred.
