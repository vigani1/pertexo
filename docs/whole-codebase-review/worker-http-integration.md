# Worker HTTP/provider integration review

Date: 2026-09-12. Primary reviewer fully read all three files (3,770 lines).
No database, Redis, artifact service, provider or integration test was started.
Cross-read production runtime ownership and the workspace query helper to avoid
mistaking transferred stores or connection-scoped transactions for defects.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `apps/worker/test/http-node-attempt.integration.test.ts` | KEEP; FIX/TEST WQ-127; REFACTOR/TEST WQ-128 | Strong composed durable dispatch, credential rotation, retry ambiguity, heartbeat fencing and genuine exact-redelivery assertions. Test-level acquisition holes, unbounded barriers, concurrent dependency release, shared credential mutation and replay-title overclaim reduce reliability/readability. |
| `apps/worker/test/support/http-node-attempt.fixture.ts` | KEEP; FIX/TEST WQ-127; REFACTOR WQ-128 | Fresh database name, real role-scoped transaction, context-binding fake encryption, pinned executable and explicit SQL transition setup are appropriate. Import-time owners and global mutable credentials need explicit fixture lifetime; migration child lacks error/deadline handling; polling bounds only the spaces between operations. |
| `apps/worker/test/support/http-node-attempt.runtime.ts` | KEEP; FIX/TEST WQ-127; REFACTOR WQ-128 | Real coordinator/attempt/capability composition with provider-only fakes gives meaningful integration coverage. Partial startup cleanup is incomplete; provider response script is hidden in default request counts. Injected run store does transfer to the production attempt runtime and is closed there—do not add double-close ownership. |

## WQ-127 — own the entire provider proof lifecycle

P2 FIX/TEST. Exact owners:

- `http-node-attempt.runtime.ts:createHttpNodeAttemptProofRuntime:75–394`:
  artifactVerifier is constructed before the guarded capabilities creation.
  That catch only closes the injected connection database. Queues, obliteration,
  coordinator startup, run-store construction and attempt startup have no outer
  rollback. Rejection during obliteration or coordinator/attempt creation leaves
  earlier owners inaccessible to the caller. Register each acquisition before
  the next operation; transfer the run store once into createNodeAttemptRuntime.
  The production runtime explicitly owns injected close-capable stores
  (`node-attempt-runtime.ts:265–268,334–341`); retain this contract. The injected
  connection database is borrowed by capabilities and deliberately wrapped by
  this fixture; retain that separate ownership without double closing it.
- `http-node-attempt.integration.test.ts:closeProofRuntime:252–263` and repeated
  finally blocks around `:1132–1152,1404–1416`: attempts.close and
  capabilities.close begin concurrently. Capabilities are borrowed by the
  attempt runtime, so they must remain usable until its consumer drain settles.
  Await worker drains first, then release borrowed capabilities and clients.
  Observe all cleanup failures; allSettled is not useful evidence if its results
  are discarded. Use deferred callbacks to protect against synchronous throws,
  preserve the scenario error and expose secondary cleanup failures safely.
- In the rotation case, acceptRun occurs after runtime construction but before
  its try. In heartbeat recovery, scenario admission and initial publication
  occur before the firstRuntime try. In operator replay, operator and replay
  stores are created after runtime acquisition but before try. Each fallible
  step belongs inside the owner scope; failure must still release earlier owners.
- `fixture.ts:migrateDatabase:165–194`: child handles exit but not spawn error,
  signal exit context, deadline or termination/drain on timeout. Reuse the
  already-planned bounded migration-child fixture mechanism (WQ-118), with error
  listener attached immediately and safe argument-only diagnostics.
- `fixture.ts:waitFor:148–163` bounds repeated polls, not a pending operation.
  Direct `await providerStarted`, `retryResolution` and `durableAbort` in the
  integration test can likewise outlive the test timeout. Use owned bounded
  barriers tied to job failure and fixture abort; release blocked fake provider
  work in finally. Keep the existing releaseRetryResolution in finally. Do not
  merely Promise.race and abandon SQL polls/listeners or blocked callbacks.
- Redis database 14 is fixed and both queues are force-obliterated on every
  runtime construction. This intentionally resets transport during reconstruction,
  but is not isolated from another integration invocation. Require an explicitly
  disposable endpoint/namespace and serialize its ownership or use unique queue
  prefixes supported through the composition. Preserve recovery's deliberate
  old-transport removal without deleting another run's jobs. Reuse WQ-115/WQ-123
  isolation work rather than a new global cleanup framework.
- Artifact cleanup covers only the first test's captured ID. The Slack rotation
  case executes the artifact-producing HTTP node and closes only the verifier;
  it never deletes the object. Failure after upload but before ID capture has the
  same hole. Track fixture-owned artifact identities through durable workspace
  metadata before dropping the database, drain users, delete both replicas, then
  close the verifier. Report failed deletion; never sweep unrelated workspaces.

Acceptance: inject failure after every acquisition; each non-transferred owner
closes once, transferred store closes through the runtime, no capabilities close
before worker drain, sync/rejected close cannot skip siblings, original failure
remains visible, barriers and poll work settle, and failed migration spawn cannot
hang. Service-gated verification then checks repeated/failed suites leave no
fixture connections, jobs or objects. No live leak was measured during this audit.

## WQ-128 — expose provider scenarios and keep proof claims exact

P2 REFACTOR/TEST. Preserve these strengths: manual node admission is real; HTTP
artifact bytes and stored checksum are compared; HTTP redelivery removes the
completed Bull job first and compares durable facts, audit and provider counts;
Slack/email and recovered email likewise remove the completed transport job;
stale completion is checked through the real store with the old lease. These
are not the queue-ID deduplication false proof found under WQ-117.

1. `runtime.ts:180–216` chooses email rate limiting on call 1, invalid response
   on call 3, success otherwise. This is an implicit scenario script attached to
   a general runtime factory. Make the base fake plainly successful and provide
   named, explicit response sequences from the retry/rotation tests. Capture
   requests independently of whether a dispatch override is installed; currently
   custom dispatches must maintain their own separate counters. Preserve
   beforeDispatch ordering and real executor behavior.
2. `fixture.ts:seedFixture` seeds shared connections only once; the first large
   case rotates email, and following HTTP/Slack cases permanently rotate their
   credentials. A shuffled first test would still expect original plaintext,
   secretVersionId and credential-access count 1. Allocate per-scenario workspace
   and connection identities or reset a documented fixture per case; do not turn
   the whole suite into one ordered test to hide coupling. Keep expensive schema
   setup shared if isolated rows/resources suffice. Test each named case alone
   and shuffled under the service gate. Do not call this an observed current
   serial-command failure.
3. The first test interleaves HTTP artifact/redelivery, Slack redelivery, email
   retry, secret rotation and cross-surface privacy over roughly 870 lines.
   Keep a cross-provider smoke sequence if its distinct value is documented,
   but move retry/rotation detail to scenario-local tests, with explicit response
   scripts and identities. Existing admitProviderScenario, attemptJob,
   advanceScenario and publishAndWaitForCompletion already express meaningful
   mechanics; reuse them instead of repeating raw publish/getJob/state loops.
   Keep durable assertions visible in each case; no generic assertion engine.
4. Replace duplicated concat_ws durable snapshots (`:512–578`) with a named
   structured row-query operation. concat_ws drops nulls and strings obscure
   field differences. Preserve the exact comparison fields and counts, use
   named properties, and include unchanged credential audit/provider calls.
   Poll exact jobs and fail promptly on failed rather than waiting the entire
   polling deadline for completed. This is shared fixture mechanics, not a new
   production seam.
5. The final operator-replay case (`:2436–2605`) uses a default first email
   response of rate_limited, then directly updates only workflow_runs to
   succeeded. It proves admission/key derivation for a seeded terminal run, not
   a fully completed source execution. Title also claims unchanged source
   history, but only the source key is compared after replay. Either label the
   intentional seeded-state proof and add a structured immutable source snapshot,
   or complete source retry/coordinator processing before replay. Compare source
   run/node/attempt/checkpoint/events and idempotent replay outcome. Keep separate
   evidence for logical retry key reuse (already covered in preceding tests).
6. Keep the private providerScenarioNode exhaustive switch: distinct provider
   configuration is real variation. A typed case table may simplify repeated
   HTTP/Slack target IDs/auth types/expected call counts in the rotation test,
   but don't replace the explicit early-versus-heartbeat scenario matrix with
   opaque flags or unify semantically different abort paths.
7. Scope fixture setup hooks and lazy owners inside enabled suite setup, rather
   than import side effects and multiple global beforeAll hooks. Verify disabled
   collection has no service acquisition. Current Pool constructors are lazy;
   this audit does not claim these constructors alone execute SQL. Keep
   queryAsWorkspaceRole, which checks out one client for the entire transaction.
   ContextKeyProvider is explicitly a test-only context-binding fake, not KMS
   cryptography evidence. Zero owned plaintext byte buffers in finally to model
   production lifetime, while acknowledging synthetic string tokens remain in
   assertions by design.

Order: WQ-127 ownership and isolation, explicit scenario scripts/rows, stronger
replay evidence, then reducing repetitive transport mechanics. Run narrow
fixture fault tests first and the real composed suite only against authorized
disposable services. No source edits, commits or pushes occurred.
