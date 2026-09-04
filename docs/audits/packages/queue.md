# `@pertexo/queue` implementation and architecture audit

## Review identity and conclusion

- **Audited commit:** `7e4b37840a2b86c591046e16f1de834e8da2db79`
- **Audited tree:** `8481ebf86f4b36ff70687f86a2bb7933a00d65b8`
- **Production scope:** all 10 source files and all 2,081 physical source
  lines.
- **Test scope:** all seven package test files and all 1,402 physical test
  lines, every production import, worker transport composition and handler,
  API run-event use, service-backed transport tests, package scripts, and CI.
- **Architecture sources:** the authoritative backend plan and ADRs 001, 002,
  004, 007, 012, 014, 018, 019, 021, 023, and 025.
- **Audit status:** complete for the pinned tree.
- **Implementation status:** one high-priority lifecycle defect, six medium
  contract/architecture/test gaps, and four lower-priority cleanup or
  robustness improvements remain open.

The package is necessary and has high Leverage. It owns the server-only
transport Interface between the durable PostgreSQL outbox and BullMQ, plus the
advisory Redis notification channel used to wake run-event streams. Its central
design is sound: queue payloads contain identifiers rather than workflow or
credential data; Zod schemas are strict and versioned; deterministic Bull job
IDs support idempotent enqueue; business retry remains database-owned; consumer
shutdown is bounded and abort-aware; and telemetry is deliberately unable to
change delivery behavior.

The package is not, however, finished to a best-practice standard. Producer
shutdown is neither bounded nor safe for concurrent callers. An inherited-key
object can pass the queue envelope guard even though it has neither `name` nor
`data` as own properties. The public registry advertises two maintenance jobs
that current production composition cannot deliver. A transport identity
invariant is repeated in at least eight worker handlers instead of being
enforced once at the consumer Seam. Package-local coverage omits almost all of
the run-event publisher, and two explicitly enabled transport proofs
reproducibly time out while their intended Bull work has already completed.

No recommendation below is based on line count alone. `producer.ts` and
`consumer.ts` contain substantial cohesive behavior. The useful refactors are
the ones that centralize a real invariant or separate a distinct owner, not
mechanical extraction into thin forwarding helpers.

## Evidence collected

The audit used full-file reading, export and callable inventory, repository-wide
import/symbol searches, producer-to-consumer traces, plan/ADR comparison,
TypeScript compilation, build, ESLint, all package tests, explicit V8 coverage,
runtime hostile-object counterexamples, and service-backed PostgreSQL/Redis
integration runs.

| Check | Result |
| --- | --- |
| `pnpm --filter @pertexo/queue typecheck` | Passed |
| `pnpm --filter @pertexo/queue build` | Passed |
| `pnpm --filter @pertexo/queue test` | 7 files and 39 tests passed |
| `pnpm exec eslint packages/queue/src packages/queue/test` | Passed |
| Ad hoc package-source V8 coverage | 76.98% statements, 67.30% branches, 79.03% functions, 77.68% lines |
| `run-event-notifications.ts` local coverage | 10.34% statements, 0% branches, 0% functions |
| Inherited envelope counterexample | Accepted an object whose own keys were `x` and `y` and whose prototype supplied `name` and `data` |
| Registry freeze counterexample | registry object frozen; each registry entry remains mutable |
| Worker transport integration, normal configuration | files collected but skipped without opt-in environment flags |
| Explicit API run-event integration | 1 test passed |
| Explicit worker transport integration | 4 tests passed; 2 tests timed out at 30 seconds |
| Unsafe-outcome isolated rerun | still timed out after 60 seconds; Bull failed job showed one attempt and the expected unrecoverable reason |

The unit result is meaningful but is not full transport proof. Queue unit tests
use realistic Bull/Redis-shaped fakes for state transitions and failure modes;
the service-backed tests exercise real PostgreSQL and Redis. The latter are
opt-in locally. CI supplies their flags and services, but the reproduced timeout
means that presence in CI is not the same as a reliable proof.

## Architecture, ownership, and dependency direction

### Module purpose and boundaries

`queue` is a server-only infrastructure Module with four responsibilities:

1. canonical job names, routing, and payload contracts;
2. the BullMQ producer and consumer Adapters;
3. Redis/Bull operational telemetry;
4. advisory run-event notification publication.

The dependency direction is appropriate. The package depends on Zod, BullMQ,
ioredis, and OpenTelemetry only. It has no dependency on database schemas,
NestJS, worker domain services, workflow execution, providers, or applications.
The worker supplies durable outbox/inbox behavior around it, while the API uses
only the run-event notification surface. Browser exports are disabled and every
runtime entry loads the server-only guard.

The durable truth is correctly outside this Module. Redis/BullMQ carries wakeup
and delivery hints; PostgreSQL owns publication, receipts, retries, leases,
recovery, and replay. The consumer passes an `AbortSignal` and transport
metadata without pretending it can forcibly cancel arbitrary JavaScript work.
Those are strong and appropriate boundaries for a workflow platform.

### Depth, Interface size, and Locality

The Module has good conceptual Depth but a wider public Interface than current
consumers need. The root exports schemas, registry internals, concrete classes,
factories, errors, metrics contracts, instrumentation, and notification
encoding. Six additional package subpaths expose overlapping parts of that
surface. Repository consumers use the root and
`./run-event-notifications`; no production consumer was found for the other
five subpaths.

Keep the factories and structural ports public. Treat concrete Bull classes,
the mutable-detail registry, and Redis instrumentation as advanced/internal
surfaces unless a demonstrated consumer requires them. Removing a private
monorepo export is still a compatibility change and should be preceded by a
repository-wide import check and a release note.

Source Locality is mostly acceptable:

- contract ownership is in `contracts.ts` and `names.ts`;
- queue policy is isolated in `defaults.ts`;
- producer and consumer lifecycle are separate;
- generic Redis telemetry is separated from its OpenTelemetry Adapter;
- live notification behavior is isolated.

The strongest internal deepening opportunity is shared Redis endpoint
validation plus resource lifecycle. Producer, consumer, and notification
publisher each implement nearly identical URL validation; the API subscriber
adds another real caller. A small internal `redis-endpoint.ts` can validate and
normalize once without becoming a broad “utils” bucket. Transport job identity
is a separate contract owner and belongs with job parsing rather than in eight
business handlers.

## Complete production-code review

### `src/server-only.ts`

The guard is minimal and is loaded before implementation exports. The package
export map and `browser: false` map are the main protection; this file is
defense in depth. As in other server-only packages, braces would make the
security guard safer to extend, but the current one-line form is not a defect.

### `src/names.ts`

`QUEUE_NAME`, `JOB_NAME`, and `QUEUE_FOR_JOB` provide an explicit closed
vocabulary. The routing map is preferable to name-derived routing and TypeScript
checks that every job has a queue. Freezing top-level maps protects accidental
mutation.

`QueueJobName` is an exact alias of `JobName` and has no repository consumer.
It adds vocabulary without encoding a new concept (QUEUE-011). Either use one
name consistently or make a future distinction real before introducing an
alias.

The map still contains `sweep-expired-previews` and `expire-artifacts`. Their
presence is not harmless documentation: it makes them parseable, routable, and
observable as supported production work even though current composition cannot
execute them (QUEUE-003).

### `src/contracts.ts`

The payload schemas are strict, versioned, identifier-only, and constrain UUIDs,
fence tokens, and W3C trace context. Discriminating through
`QueueJobDataByName` gives producers and handlers precise payload types. Unknown
job names become a stable domain error, while known names with malformed data
preserve Zod detail. That division is useful for dead-letter diagnosis.

`isQueueJobEnvelope` uses `'name' in value` and `'data' in value`, then only
checks that the object has two own enumerable keys. These predicates are not
equivalent. A crafted prototype can provide `name` and `data` while the object
owns unrelated keys. The guard then admits it and dispatches using inherited
values. Inputs normally originate in BullMQ's JSON decoder, but
`parseQueueJob` is public and the consumer accepts `unknown`; the trust boundary
must enforce its own stated exact-envelope invariant (QUEUE-002).

Use a non-array object check, `Object.hasOwn` for both required fields, and an
exact own-key comparison. Decide explicitly whether null-prototype objects are
valid. If hostile proxies are in scope, catch reflection traps and return a
stable parse failure rather than leaking arbitrary exceptions.

`QUEUE_JOB_REGISTRY` is a useful single dispatch table, but only its outer map
is frozen. Each `{ queueName, schema }` entry remains replaceable internally by
any holder. Zod schemas are intentionally stateful objects and should not be
deep-frozen blindly; freeze the entry records and keep schemas referenced
(QUEUE-010).

The ten near-parallel schemas are acceptable explicitness. A generic schema
builder would save few lines while making individual wire shapes harder to
review. The right reduction is generated compatibility fixtures/snapshots, not
an abstraction that hides fields.

### `src/defaults.ts`

The four queue classes make transport retry, backoff, retention, concurrency,
timeouts, and stalled-job limits explicit. Defaults are deeply enough frozen
because values are primitive entry records, though freezing the entries would
make that guarantee complete.

Transport retries are intentionally low and do not encode workflow policy.
That matches the plan: durable business retry and recovery are PostgreSQL-owned.
Different timeouts for trigger lifecycle and maintenance are documented and
reasonable. These are operational defaults, not SLO proof; production
calibration still belongs to load testing and telemetry.

### `src/producer.ts`

Configuration validation rejects credentials outside `redis:`/`rediss:`,
bounds readiness/publish timeouts, and copies connection settings into an owned
ioredis connection. One Queue per queue class makes routing explicit.

`jobIdForOutboxEvent` centralizes deterministic IDs and the producer reparses
every job before enqueue. `toJobOptions` correctly selects the queue-class
policy. Publish uses a bounded settlement model and distinguishes known
publication from `outcome_unknown`, which is essential because timing out does
not prove enqueue failed. The timeout is unref'd and later observation reports
only aggregate, non-payload state.

Shutdown is the major defect. `close()` marks the producer closed before cleanup
settles and awaits `Queue.close()` plus `redis.quit()` with no bound. A stalled
network or Bull close can therefore hold shutdown forever despite the plan's
bounded-shutdown requirement. Calls are not memoized: a second concurrent
caller immediately resolves while the first still owns resources. If the first
call rejects, later calls also resolve because lifecycle already says closed,
so cleanup cannot be retried and the original failure is hidden (QUEUE-001).

Model producer close after consumer close: store one close promise, bound
graceful operations, disconnect as fallback, and make all callers observe the
same result. Keep a distinction between “closing” and “closed”; set final state
after teardown. The worker dispatcher currently wraps producer close in its own
five-second bound, which limits one composition path but does not repair the
package contract or release the underlying work.

`performObserve` performs two Redis requests per queue concurrently and returns
frozen snapshots. Depth includes waiting and delayed jobs while oldest age uses
waiting only; the comment and metric semantics make that distinction explicit.

### `src/consumer.ts`

The consumer has the package's most complex Implementation, but its complexity
is largely intentional. It owns readiness, Bull event translation, schema
parsing, trace activation, deadline/abort races, active execution tracking,
failure classification, telemetry isolation, graceful drain, forced abort, and
connection fallback. These behaviors share lifecycle state; splitting them
into unrelated services would reduce Locality.

The lifecycle is stronger than the producer's. `closePromise` makes close
idempotent for concurrent callers. Pause, active-drain wait, Bull close, and
Redis quit are bounded. Forced shutdown aborts contexts and cancels Bull jobs.
Observer and trace Adapter failures cannot change delivery semantics. Stable
invalid payloads use Bull's unrecoverable error so transport retries do not
repeat permanent poison messages.

The timeout race is cooperative: a handler that ignores its signal can keep
executing after the queue attempt rejects. JavaScript cannot safely terminate
arbitrary in-process work, so this is an explicit handler contract rather than
a package bug. Every handler must pass the signal to I/O and fencing checks.

The consumer accepts any non-empty Bull `job.id` and never proves it equals
`outbox-${data.outboxEventId}`. At least eight worker handlers repeat that same
comparison before domain processing. This is a textbook missing Seam: the
transport Adapter has both values and should reject the mismatch once before
business dispatch. Repetition risks a future handler omitting the guard and
mixes transport identity with domain logic (QUEUE-004). Preserve handler-level
payload checksum and tenancy checks; they prove different invariants.

The two option parsers duplicate Redis URL logic from the producer and live
publisher. Extract only this narrow stable concern. Keep producer- and
consumer-specific timeout schemas near their owners.

### `src/redis-telemetry-contracts.ts`

This file defines a small dependency-inversion port and safely wraps observer
callbacks. Redis operation error classification is deliberately coarse and
bounded-cardinality. Instrumentation preserves the original command function,
observes async success/failure, and uses a `WeakSet` to avoid rewrapping.

The first instrumentation call permanently owns the observer and role for a
client. That is acceptable for currently owned clients but should be documented
on the public function. A synchronous non-thenable return is not reported as a
successful command; current ioredis commands return promises, so this is an
unverified library assumption rather than a current defect. Add a contract test
against the pinned ioredis behavior if this monkey patch remains public
(QUEUE-009).

### `src/redis-telemetry.ts`

The OpenTelemetry Adapter maps the bounded internal port to counters and
histograms without payload, tenant, URL, command argument, or exception-message
labels. That is correct cardinality and secrecy behavior. The production
factory is simple and testable. No unnecessary class hierarchy is present.

### `src/run-event-notifications.ts`

The notification path correctly treats Redis as advisory. Channels are opaque
SHA-256 derivations from workspace/run IDs, references are small identifier-only
messages, and the API subscriber re-reads durable state after a notification or
resync marker. The channel is not an authorization mechanism, which is the
right security model.

Constructor validation, message byte bounds, publish timeout, telemetry, and
close behavior are reasonable. Unlike the main producer, the timeout timer is
not `unref()`'d. A timed-out publish continues in the background and its later
rejection is consumed by `Promise.race`; this avoids an unhandled rejection but
does not cancel Redis I/O. Document advisory settlement and unref the timer
(QUEUE-008).

This file repeats Redis URL validation a third time. The API run-event source
contains a fourth parser with the same protocol/credential rules. A focused
shared parser would improve consistency and make redaction rules reviewable
(QUEUE-005).

### `src/index.ts`

Named exports make the root API auditable and `.js` specifiers are correct for
NodeNext ESM. The root intentionally aggregates contracts and runtime Adapters.
It currently exports internal-detail surfaces and omits several job schemas and
types that nevertheless exist at the `./contracts` subpath. This produces an
uneven Interface: callers cannot predict whether a new job is root-exported.

Choose and document one rule—either all wire contracts are public at root or
consumers import the contracts subpath—and test that rule from an explicit
manifest. Narrow unused subpaths and aliases after consumer verification
(QUEUE-011).

## Tests, coverage, and CI

### Package tests

- `contracts.test.ts` proves strict identifier-only parsing, unknown names,
  schema versions, UUIDs, trace context, and fence values. Its test named
  “every supported” omits `ReplayWorkflowRunJob`, so the claim is false.
- `names.test.ts` proves exact name/routing maps and immutable roots.
- `defaults.test.ts` proves the intended class defaults.
- `producer.test.ts` covers validation, readiness, deterministic publication,
  queue policy, timeout ambiguity, observations, and close failures with useful
  stateful fakes.
- `consumer.test.ts` covers validation, readiness, parsing, handler errors,
  timeout/abort, telemetry isolation, graceful and forced drain, and lifecycle.
- `redis-telemetry.test.ts` covers event and async command observations and
  observer-failure isolation.
- `package-contract.test.ts` proves every export-map entry is server-only.

These tests generally assert behavior rather than implementation trivia. Fakes
are appropriate for deterministic lifecycle branches, while real service tests
cover the Adapter boundary. The main omissions are exact-own envelope attacks,
transport job-ID mismatch, concurrent/rejected producer close, complete job
registry iteration, and direct live-publisher behavior.

### Coverage controls

The package has no `test:coverage` script, is absent from the root critical
coverage command, and has no threshold. Explicit audit coverage is only 76.98%
statements and 67.30% branches. Most importantly,
`run-event-notifications.ts` is almost entirely unexecuted in the package suite.
API unit tests cover wrapper/subscriber behavior through aliases, but they are
not a package-owned regression gate and can change without protecting this
Module (QUEUE-006).

Add a package V8 configuration with meaningful per-file thresholds and include
it in the risk report or root coverage command. Start from measured baselines,
then add risk-based tests for the omissions above. Do not maximize percentage by
testing trivial constants; prioritize parsing, lifecycle, settlement ambiguity,
and cancellation.

### Contract compatibility tests

The plan calls for public queue schema snapshots. Current tests assert selected
examples and exact name maps but do not persist a canonical serialized schema
or old/new compatibility corpus. A strict Zod schema change can silently break
queued work that predates a deployment. Add canonical schema artifacts or
golden fixtures for every name/version and tests that the current parser still
accepts supported historical messages (QUEUE-007).

### Service-backed integration reliability

With integration flags unset, direct local runs collect and skip the worker
transport files. With the documented local PostgreSQL/Redis services and
`WORKER_TRANSPORT_INTEGRATION=true`, four selected tests passed and two timed
out. The unsafe-outcome test timed out again in isolation at 60 seconds. Redis
showed its target job in `failed` with `attemptsMade = 1` and the expected
`UnrecoverableError`, so the core assertion had occurred before the process
stalled.

The tests await custom deferred promises and several cleanup operations without
stage-specific bounds. When a handler fails before resolving a deferred—or
cleanup hangs—Vitest can report only a whole-test timeout. Cleanup removes
tracked workflow-coordinator IDs but does not track/remove generated
node-attempt job IDs; repeated runs left completed and failed test jobs in the
shared Redis database. This makes failure diagnosis poor and local state
non-hermetic (QUEUE-012).

Give every deferred wait a named bounded helper, bound each cleanup resource,
track all queue IDs, and isolate Redis by a per-run key prefix or database when
possible. On failure, report Bull state/failed reason and pending stage. Then
rerun the exact CI integration command repeatedly from a clean service state.

CI does run `@pertexo/queue` unit tests in the core matrix. The coverage job
does not cover this package directly. The integration workflow starts real
PostgreSQL and Redis services and opts worker/API integration tests in. That is
the correct shape, but the test-harness reliability gap prevents treating every
green/timeout result as unambiguous transport evidence.

## Plan and ADR compliance

| Requirement | Assessment |
| --- | --- |
| Server-only transport package | Satisfied |
| Identifier-only payloads; no workflow/credential secrets | Satisfied |
| Versioned strict queue contracts | Satisfied for current messages |
| Deterministic outbox-derived Bull job IDs | Satisfied in producer; repeated rather than central consumer verification |
| PostgreSQL owns durable retry/recovery | Satisfied |
| BullMQ retry is transport-only | Satisfied |
| Bounded startup/readiness | Satisfied |
| Bounded graceful shutdown | Consumer satisfied; producer violates it |
| Cooperative cancellation | Satisfied; handler compliance remains a continuous control |
| Trace propagation and bounded telemetry | Satisfied |
| Public schema snapshot/compatibility guard | Not satisfied |
| Real PostgreSQL + Redis transport proof | Present, but currently not locally reliable |
| Preview retention moved away from API/queue sweep | Queue registry is stale and contradicts the migration/current runtime |
| Artifact expiry workflow | Advertised by queue contract but no composed production handler/outbox creator found |

The implementation plan remains directionally correct. The current conflicts
come from later implementation evolution not being reflected in the queue
Interface and from verification/lifecycle details that the plan explicitly
expected.

## Findings and required remediation

### QUEUE-001 — Producer close can hang and concurrent callers observe false completion

- **Severity:** P1
- **Classification:** Confirmed defect
- **Evidence:** `producer.ts` marks lifecycle closed, then awaits unbounded
  Queue/Redis closes; it stores no shared close promise. Rejection leaves the
  object permanently “closed” and subsequent close calls return successfully.
- **Impact:** process shutdown can exceed its budget, resources can remain open,
  and orchestration can believe teardown completed when another caller is still
  closing.
- **Remediation:** add a closing state and memoized promise; bound graceful
  close; disconnect on timeout; settle final state once; make all callers
  observe one result.
- **Verification:** concurrent-close, timeout, partial-rejection, retry/fallback,
  and no-open-handle tests with real Redis coverage.
- **Status:** Open.

### QUEUE-002 — Queue envelope accepts inherited `name` and `data`

- **Severity:** P2
- **Classification:** Confirmed defect
- **Evidence:** a runtime object with own keys `x`,`y` and valid `name`,`data`
  on its prototype passed `parseQueueJob`.
- **Impact:** the public unknown-input boundary does not enforce the exact shape
  described by its error and can dispatch inherited data.
- **Remediation:** require exact own keys and define allowed prototypes;
  normalize reflection failures if hostile proxies are supported.
- **Verification:** inherited, null-prototype, array, accessor, symbol, proxy,
  and extra-key contract tests.
- **Status:** Open.

### QUEUE-003 — Registry advertises non-deliverable maintenance work

- **Severity:** P2
- **Classification:** Confirmed architecture/contract defect
- **Evidence:** `sweep-expired-previews` remains parseable/routable after
  migration 0053 moved preview retention to a no-HTTP retention runtime and the
  worker rejects it. `expire-artifacts` is configured as supported but has no
  composed production consumer or production outbox creator.
- **Impact:** operators and producers can infer support for work no runtime can
  complete; enabling the speculative job fails readiness or strands work.
- **Remediation:** remove the obsolete preview contract through a compatibility
  decision; keep artifact expiry out of the active registry until its vertical
  slice exists, or implement and compose that slice explicitly.
- **Verification:** generate producer, dispatcher, capability, and handler
  inventories from one active-job manifest and assert every active job has an
  owner.
- **Status:** Open.

### QUEUE-004 — Transport job identity is duplicated across handlers

- **Severity:** P2
- **Classification:** Maintainability and defense-in-depth improvement
- **Evidence:** consumer validates only non-empty Bull IDs; at least eight
  worker handlers repeat comparison with `jobIdForOutboxEvent`.
- **Impact:** every new handler must remember a transport invariant, and
  business code is coupled to Bull naming.
- **Remediation:** validate the deterministic ID once after parsing and before
  handler dispatch; expose a stable invalid-delivery error. Retain database
  checksum/fence validation.
- **Verification:** mismatch rejection in consumer plus handler tests proving
  domain logic never starts.
- **Status:** Open.

### QUEUE-005 — Redis endpoint policy is copied across four owners

- **Severity:** P2
- **Classification:** Maintainability improvement
- **Evidence:** producer, consumer, publisher, and API subscriber repeat
  protocol/credential parsing and error mapping.
- **Impact:** security and redaction behavior can drift between connections.
- **Remediation:** introduce one narrow internal validator returning a
  normalized URL; let each owner map its domain-specific configuration error.
- **Verification:** one table-driven endpoint corpus used by all four callers.
- **Status:** Open.

### QUEUE-006 — Risk-critical package code has no coverage gate

- **Severity:** P2
- **Classification:** Continuous-control gap
- **Evidence:** no package coverage script/threshold; explicit branch coverage
  is 67.30%; the live publisher has 0% function/branch package coverage.
- **Impact:** regressions can merge while the root coverage command remains
  green.
- **Remediation:** add V8 coverage and risk-based tests, then include this
  package in the repository risk report.
- **Verification:** CI fails when required queue lifecycle/contract branches are
  uncovered.
- **Status:** Open.

### QUEUE-007 — Versioned queue schemas lack compatibility snapshots

- **Severity:** P2
- **Classification:** Continuous-control gap
- **Evidence:** example parsing exists, but no canonical schema/golden historical
  artifact protects every job/version.
- **Impact:** deployments can reject already-enqueued messages after a strict
  schema change.
- **Remediation:** persist canonical contracts and historical message fixtures;
  require deliberate versioning for breaking changes.
- **Verification:** previous supported fixtures parse on every CI run and schema
  diffs are reviewable.
- **Status:** Open.

### QUEUE-008 — Live notification timeouts retain referenced timers

- **Severity:** P3
- **Classification:** Robustness improvement
- **Evidence:** publisher timeout uses `setTimeout` without `unref`, unlike the
  main producer.
- **Impact:** a lone pending advisory timeout can delay process exit by up to
  two seconds.
- **Remediation:** unref the timer and document that timeout does not cancel the
  underlying Redis operation.
- **Verification:** fake-timer and open-handle shutdown test.
- **Status:** Open.

### QUEUE-009 — Public Redis monkey patch relies on undocumented ioredis behavior

- **Severity:** P3
- **Classification:** Unverified production assumption
- **Evidence:** first instrumentation owns observer/role; successful sync
  non-thenable commands are not observed. Pinned ioredis commands are expected
  to be promise-like.
- **Impact:** reuse with a different client mode or wrapper can silently lose or
  misattribute telemetry.
- **Remediation:** document ownership, narrow visibility if internal, and add a
  pinned-library contract test.
- **Verification:** real-client success/failure/event test.
- **Status:** Open.

### QUEUE-010 — Registry entry records are mutable

- **Severity:** P3
- **Classification:** Maintainability improvement
- **Evidence:** runtime check showed root frozen and inner records unfrozen.
- **Impact:** accidental mutation can desynchronize routing and parsing in a
  long-lived process.
- **Remediation:** freeze entry records without deep-freezing Zod internals.
- **Verification:** immutability test for root and every entry.
- **Status:** Open.

### QUEUE-011 — Public API contains unused aliases/subpaths and inconsistent contract exports

- **Severity:** P3
- **Classification:** Maintainability improvement
- **Evidence:** `QueueJobName` has no consumer; five subpaths have no production
  imports; root exports only a subset of job schemas/types.
- **Impact:** larger compatibility surface and less predictable imports.
- **Remediation:** define a public-surface rule, retain only demonstrated seams,
  and add an explicit export manifest test.
- **Verification:** repository import search plus API-extractor-style snapshot.
- **Status:** Open.

### QUEUE-012 — Transport integration harness is non-hermetic and masks its stalled stage

- **Severity:** P2
- **Classification:** Confirmed test-infrastructure defect
- **Evidence:** two explicit tests timed out; isolated unsafe-outcome test still
  timed out at 60 seconds although Redis recorded the expected one-attempt
  unrecoverable failure. Deferred waits are unbounded and cleanup leaves
  node-attempt jobs in shared Redis.
- **Impact:** CI/local failures are slow and non-diagnostic; stale jobs can
  influence later runs; intended correctness evidence is ambiguous.
- **Remediation:** bound and name every stage, isolate Redis state, track all job
  IDs, bound cleanup, and print relevant Bull state on failure.
- **Verification:** repeated clean and dirty-state runs of the exact CI command
  complete within budget with no residual keys.
- **Status:** Open.

## What should remain unchanged

- Keep the package server-only and keep applications depending on structural
  ports/factories rather than constructing Redis clients throughout domain code.
- Keep queue payloads identifier-only and versioned.
- Keep durable retry, leases, replay, and receipts in PostgreSQL.
- Keep deterministic outbox-derived Bull IDs and outcome-unknown semantics.
- Keep telemetry labels bounded and exclude payloads, URLs, tenant IDs, and
  arbitrary error messages.
- Keep consumer cancellation cooperative and require handlers to honor signals;
  do not imply JavaScript work can be safely killed in-process.
- Keep explicit per-job schemas. Do not replace them with a clever generic
  builder merely to reduce repetition.
- Keep producer and consumer as separate owners. Split files only where shared
  invariant ownership or lifecycle testing becomes clearer.

## Recommended implementation order

1. Fix producer close semantics and add lifecycle regression tests
   (QUEUE-001).
2. Close the envelope and transport-ID trust boundaries (QUEUE-002,
   QUEUE-004).
3. reconcile the active job registry with actual vertical slices (QUEUE-003).
4. repair and repeatedly run the service-backed harness (QUEUE-012).
5. add schema compatibility and package risk-coverage gates (QUEUE-006,
   QUEUE-007).
6. centralize Redis endpoint policy, then narrow/freeze the public surface
   (QUEUE-005, QUEUE-009 through QUEUE-011).
7. apply the small notification-timer robustness change (QUEUE-008).

After remediation, rerun build, lint, typecheck, package tests, package coverage,
the exact CI worker/API integration commands against fresh services, and the
whole repository pre-push gate. Close findings only with concrete command and
behavior evidence.
