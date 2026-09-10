# Risk-based test confidence

`pnpm test:coverage` runs the coverage configurations selected by the
[root package script](../../package.json) and writes
`coverage/risk-uncovered-branches.json`. The report's
scope lists those exact files, coverable-line denominator, percentages, and
test-health record by cohort. It must not be described as coverage of every
security, transaction, recovery, parser, or state-transition surface.

Generated and declarative files are excluded by positive `include` lists, not by
lowering thresholds. Every generated branch entry starts with review status
`unreviewed`; generation performs no risk classification. A reviewer may later
classify an exact site as unreachable, compiler-generated, deliberately
defensive, or covered by a named integration cohort only with a narrow written
justification. Testable unit paths are exercised instead of classified. The
generated report remains a CI artifact and is not committed because locations
change with source edits. Exact reviews live in the committed manifest, and
missing, duplicate, malformed, or stale identities fail the report.

The workflow transition matrix, retry decision table, workspace
role-capability matrix, and provider dispatch-fence tests are mutation canaries.
They enumerate allowed/denied or safe/unsafe decision spaces, so inverting a
high-consequence authorization, transition, retry, or fence decision fails the
suite. Percentage thresholds are ratchets rather than targets and may only move
upward after meaningful tests or new risk-bearing source enters a measured
cohort.

## High-consequence behavior inventory

This inventory was checked on 2026-09-09 against the uncommitted working tree
based on `9a09ccec09fa97215f54ed46a687cb00805dd4f6`. That commit alone does not
identify the candidate. The rows record representative owning evidence rather
than claiming that every catch branch or external environment has been tested.

| Behavior | Direct or component evidence | Composed, process, or PostgreSQL evidence | Protected outcome |
| --- | --- | --- | --- |
| Authorization loss | `apps/api/test/workflow-runs/sse-transport.test.ts` covers already-lost authorization, refresh loss, blocked transport and listener cleanup; `apps/api/test/workflow-runs/use-cases.test.ts` covers membership, session and workspace-lifecycle loss | `apps/api/test/identity-workspace/real-api.integration.test.ts` rejects revoked and expired persisted sessions | No later frame or persistence read is admitted; the producer is aborted and replay remains bound to the durable cursor |
| Aborted external work | `packages/queue/test/consumer.test.ts`, `apps/worker/test/node-runtime-capabilities.test.ts` and `apps/worker/test/failure-notification-delivery.test.ts` cover pre-admission, in-flight, credential-loading and decrypted-secret cancellation | `packages/integrations/test/secure-http.test.ts` covers cancellation before and after the durable dispatch-marker boundary | Provider work receives the owned signal, secret/body buffers are cleared, and retry truth remains pre-dispatch or ambiguous as applicable |
| Failed initialization and shutdown | `apps/api/test/api-bootstrap.test.ts` covers partial factory failure, incompatible readiness and aggregate close failure; `apps/worker/test/worker-readiness-lifecycle.test.ts` covers terminal drain ordering | `apps/worker/test/worker-process-shutdown.test.ts`, `apps/operator-command/test/run.test.ts` and `apps/recovery/test/restore-before-serve.test.ts` cover executable shutdown and partial-start cleanup | Every constructed owner is closed once, drain/readiness changes happen in order, and primary plus cleanup failures remain observable |
| Exhausted pool or acquisition wait | `packages/database/test/artifact-upload-runtime.test.ts`, `packages/database/test/workspace-purge-cancellation.test.ts` and `packages/database/test/control-ledger-coordinator.test.ts` cover canceled acquisition and late-client release/destruction | `packages/database/test/retention-transaction-cancellation.integration.test.ts` queues behind a real busy PostgreSQL client and verifies prompt cancellation | No destructive or provider work starts, queued demand clears, and a client arriving after cancellation is not reused unsafely |
| Stale lease or fence | `packages/database/test/workspace-purge-cancellation.test.ts` and worker attempt tests cover stale local ownership decisions | `packages/database/test/preview-worker-attempt-lifecycle.integration.test.ts`, `packages/database/test/transport.integration.test.ts` and `packages/database/test/coordinator-run-store-node-attempts.integration.test.ts` exercise real lease-token and credential-fence rejection | A stale owner cannot heartbeat, complete, publish or mark provider dispatch |
| Duplicate delivery | Queue and worker handler tests cover exact replay and checksum-conflict classification | `apps/worker/test/transport-part-2.integration.test.ts`, `packages/database/test/transport-part-2.integration.test.ts` and `packages/database/test/preview-worker-attempt-lifecycle.integration.test.ts` cover concurrent duplicate receipt and terminal redelivery | One transport identity yields one atomic business mutation; divergent reuse fails and rollback leaves no completed receipt |
| Ambiguous dispatch | Retry tables plus Slack, email and HTTP executor tests distinguish definitely-unsent from possibly-dispatched outcomes | `apps/worker/test/transport-part-2.integration.test.ts` and `packages/database/test/preview-worker-reconciliation.integration.test.ts` retain ambiguity through BullMQ and durable wake-up | Unsafe work is not blindly retried; stable-key idempotent work retains its binding and prior ambiguity is not erased by a later failure |
| Transaction rollback | `packages/database/test/workspace-transaction-engine.test.ts` preserves operation, rollback, cleanup and release failures | `packages/database/test/transport.integration.test.ts`, `packages/database/test/transport-part-2.integration.test.ts`, `packages/database/test/preview-worker-attempt-lifecycle.integration.test.ts` and `packages/database/test/retention-transaction-cancellation.integration.test.ts` verify rollback on real PostgreSQL | Domain facts, inbox receipts, outbox rows and usage/provider intent commit together or remain absent together; contaminated clients are destroyed |

Cancellation is therefore exercised at acquisition, in-flight work,
pre-dispatch, post-dispatch, transaction rollback and cleanup boundaries. The
secure HTTP marker-race test also prevents cancellation from being reported as
definitely pre-dispatch while its marker can still commit. A forced uncertain
wire failure during PostgreSQL `COMMIT` is not simulated locally; that remains a
driver/service failure qualification limit rather than a reason to weaken the
durable ambiguity policy.

## Mutation sensitivity record

The same working tree was copied to disposable fixtures for perturbation; the
fixtures were deleted after the checks. No production source mutation was made
in the checkout. The restored baseline passed the six owning files covering
the new and existing decisions: 4 workflow-model tests, 3 transition tests, 2
retry tests, 2 authorization tests, 40 Slack tests and 17 queue-consumer tests.

| Canary | Disposable perturbation | Expected red result |
| --- | --- | --- |
| Transition matrix | Remove `queued -> running` from the run transition table | `transition-policy-mutation.test.ts` fails on `queued -> running` |
| Retry ambiguity | Invert the unsafe side-effect check for possibly-dispatched work | `retry-policy-mutation.test.ts` observes `retry` instead of `outcome_unknown` |
| Workspace authorization | Replace the capability membership decision with unconditional allow | `workspace-authorization-policy.test.ts` observes an allowed denied capability |
| Provider dispatch fence | Omit the connection fence and binding passed to `beforeDispatch` | `slack-send-message.test.ts` no longer rejects the rotation race before provider bytes |
| Abort handoff | Give the queue handler an unrelated signal | `consumer.test.ts` observes that timeout/cancellation did not abort the delivered signal |
| JSON-path own-property guard | Remove `Object.hasOwn` from object traversal | `mapping.test.ts` resolves an inherited value instead of reporting it missing |

The JSON-path case was the only selected decision without a direct faulting
input, so `packages/workflow-model/test/mapping.test.ts` now supplies both an
owned and inherited property. Existing malformed-input controls remain owned by
`packages/node-sdk/test/registry.test.ts` and
`infrastructure/browser-entry-dependencies.test.mjs`. Mutable image references
are rejected by `infrastructure/validate-image-pins.test.mjs`; missing, failed,
skipped, mismatched and stale integration evidence is rejected by
`infrastructure/report-risk-coverage.test.mjs`. Those negative fixtures are
kept distinct from the six source-policy perturbations above.

Each coverage command also writes a Vitest JSON result beside its coverage
files. The combined report records elapsed duration, passed, failed, skipped,
and todo tests per cohort. Retries are deliberately disabled, so retry attempts
and retry-masked flakes are both structurally zero; a failed test cannot become
green through an automatic rerun. CI uploads the per-run JSON with the coverage
artifact, making duration and health comparable across retained workflow runs.

### Next-stage composed fault controls

N09 adds a separate seven-mutation proof for the behaviors introduced or
strengthened after the record above. `pnpm mutation:check` copies the exact
tracked and non-ignored untracked candidate into an owned temporary directory,
installs from the local pnpm store, builds it, records a private Git identity,
and applies one mutation at a time. The owning command must fail with its named
test, the original bytes are restored, any affected package is rebuilt, and the
same command must pass. A mutation is never retried, the working checkout is
never edited, and the snapshot is deleted in `finally`.

| Canary | Disposable perturbation | Exact owning case |
| --- | --- | --- |
| Provider classification | Map transient HTTP credential-resolution failure from retry/provider to failed/internal | Worker HTTP/PostgreSQL/BullMQ case `persists a transient HTTP credential-resolution failure` |
| Prior dispatch uncertainty | Return only the current dispatch flag from the shared early/heartbeat control helper | Worker handler case `preserves prior dispatch uncertainty across early and heartbeat control paths` |
| Quality-runner cleanup | Wait for inherited output pipes before terminating owned descendants | Quality CLI process case `a failed command cannot orphan its nested workload while a descendant inherits output pipes` |
| Benchmark-runner cleanup | Apply the same close-before-cleanup regression to the shared lifecycle primitive | Benchmark CLI process case `a failed benchmark command cannot hang on output pipes inherited by a descendant` |
| Attempt completion fence | Remove only the attempt fence-token comparison while every other active-lease condition remains true | Database/PostgreSQL case `rejects completion when only the durable attempt fence is stale` |
| Lost-COMMIT duplicate | Bypass the zero-row inbox duplicate branch after the server commits but its acknowledgement is dropped | Database wire-proxy case `recovers an atomic inbox outcome after the COMMIT acknowledgement is lost` |
| Performance compatibility | Accept differing benchmark manifest hashes | Comparator case `rejects host, runtime, service and manifest mismatches but allows source changes` |

The isolated partial run
`2026-09-10t04-02-26-525z-46926-543dedbf` passed all seven red/restored-green
pairs on stable candidate fingerprint
`4dc9be1ccb16385c8545b1995a2ae009036334675fa55083ee3ce3fccafb0074`.
Red durations ranged from 59 ms to 6.081 s and restored-green durations from
59 ms to 5.700 s; these timings establish execution, not performance budgets.
Its manifest SHA-256 is
`51b5e0015a20230382fb9d56b3bba5822397cbe6d161a621a3e83f3e31c49b94`
and mutation log SHA-256 is
`97dd23654ee8e124056e632ea8a594c1dc5c702aa3076b64b51bbf4ebf78a1e3`.
The partial manifest truthfully marks every unselected cohort skipped and is not
full qualification; the final full runner executes this proof again as a
required cohort.

Real-service integration, compatibility, recovery, provider, load, and
deployed-drill evidence remains in separate commands and artifacts. The risk
coverage report may link an uncovered unit-instrumentation branch to a named
integration test, but it never counts that external cohort as unit execution.
