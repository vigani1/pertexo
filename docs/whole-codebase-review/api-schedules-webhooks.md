# API schedules and webhooks review

Date: 2026-09-12. Scope: 21 inventory files read in full by the primary
reviewer. The 4 unit files / 34 tests passed. Direct webhook integration was
read, not run. ADR-014 and ADR-026 were read as governing contracts; database
interfaces and selected implementation paths were checked without crediting
the full database modules as reviewed here.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `apps/api/src/schedules/controllers.ts` | KEEP; TEST WQ-077 | Two mutations share one short command adapter; boolean enabled means exactly two states and is clearer than a new command framework. Explicit auth/update/CSRF order, empty-body validation and distinct missing-key response are intentional. |
| `apps/api/src/schedules/guards.ts` | KEEP | Read/update capabilities and active-only, hidden-not-found disclosure are explicit subclasses of the shared guard. |
| `apps/api/src/schedules/module.ts` | KEEP; TEST WQ-077 | Registers the supplied service and authorization once and imports shared identity. Small factory does not justify DI redesign. |
| `apps/api/src/schedules/service.ts` | REFACTOR WQ-076; TEST WQ-077 | Simple list/enable pipeline leaves scheduling time and recurrence to PostgreSQL. Stable actor-scoped command hash is meaningful; public projection currently spreads a storage record and tests do not actually prove hash identity. Error codes currently have only two legitimate variants. |
| `apps/api/src/schedules/telemetry.ts` | KEEP; TEST WQ-077 | At-most-once work and contained metric failures preserve command truth. Counting failure also skips duration recording, but never repeats the command. Performance clock is the native monotonic source, not a user-injected business dependency. |
| `apps/api/src/schedules/tokens.ts` | KEEP | Single stable injection identity. |
| `apps/api/src/platform/schedules/schedule-runtime.module.ts` | FIX WQ-065 extension | Owns database, bounded metric instruments and one service. Synchronous close throw occurs before the cached promise assignment; construction after database acquisition lacks failure cleanup. Preserve shared database lease ownership. |
| `apps/api/test/schedules/service.test.ts` | TEST WQ-077 | Realistic trigger fixture and known error mappings are useful. A 64-hex shape assertion does not prove the test title's actor-scoped hash; successful list/enable/replay, optional dates and telemetry behavior are uncovered here. |
| `apps/api/src/webhooks/controllers.ts` | KEEP; TEST WQ-077 | Three routes use one typed operation selector and cancellation adapter. Secret rotation validates its required endpoint key. Provision/endpoint rotation deliberately have no body contract in OpenAPI; do not add required empty-body parsing merely because an unused empty-object schema exists. |
| `apps/api/src/webhooks/guards.ts` | KEEP | Workflow-read/update capability and active workspace policy match management operations, separate from public HMAC ingress. |
| `apps/api/src/webhooks/ingress.ts` | FIX WQ-075; KEEP phase order; TEST WQ-077 | Bounded raw body, representation check, endpoint/limit/freshness, HMAC, JSON and durable acceptance are deliberate ordered phases. Raw duplicate-header rejection must not be replaced by an ordinary first-header helper. Trace/traceparent failures remain authoritative despite isolated counters. |
| `apps/api/src/webhooks/module.ts` | KEEP; TEST WQ-077 | Small supplied-service graph is correct; public Fastify ingress remains separate from authenticated Nest management routes. |
| `apps/api/src/webhooks/service.ts` | REFACTOR WQ-076; TEST WQ-077 | Credential generation, encryption, database mutation and post-command ownership proof are required by ADR-026. Independent operation-derived optionals, late missing-key check and throwing IIFE obscure those phases. Do not remove the proof read or change replay disclosure as a cleanup. |
| `apps/api/src/webhooks/telemetry.ts` | FIX WQ-075; TEST WQ-077 | Bounded counters and child-span propagation are useful. Span status/end operations can replace a work result; parent context has a syntax check but no explicit validity check. Preserve genuine remote-parent tracing while isolating diagnostics. |
| `apps/api/src/webhooks/tokens.ts` | KEEP | Stable shared authorization injection symbol. |
| `apps/api/src/platform/webhooks/webhook-runtime.module.ts` | FIX WQ-065 extension | Composes compatibility history, database and one envelope owner. Envelope close failure prevents database close, and failure during later acquisition lacks cleanup. Checkpoint factory retains the selected release rather than compiling against arbitrary current definitions. |
| `apps/api/test/webhooks/direct-webhook.integration.test.ts` | FIX/TEST WQ-078 | Real socket plus PostgreSQL atomic row counts, replay race, previous-secret boundary and quota rollback are strong. One long case interleaves unrelated stories; resources are created in collection, some cleanup errors are discarded, HTTP helper has unbounded waits and exception-prone JSON parsing. |
| `apps/api/test/webhooks/ingress.test.ts` | TEST WQ-075/WQ-077 | Real Fastify parsing/injection and one real socket close prove more than controller mocks. Exact raw bytes, size and representation distinctions are valuable. Missing diagnostic-failure, secret wiping, duplicate-header and malformed UTF-8 cases; cancellation fixture must always release its parked secret. |
| `apps/api/test/webhooks/service.test.ts` | TEST WQ-076/WQ-077 | Hash stability across new random material and endpoint-bound secret rotation are good. Fixture itself wipes the encryption input, masking service cleanup responsibility; casts hide incomplete collaborators and one replay test checks no credentials only for a different operation. |
| `apps/api/test/webhooks/telemetry.test.ts` | KEEP; TEST WQ-075/WQ-077 | Real SDK parent/child span assertion is useful. Add work failure, invalid/absent parent and diagnostic failures; move cleanup ownership before operations that can fail after SDK start. |
| `apps/api/test/support/disposable-database.ts` | KEEP safety approach; TEST WQ-078 | Quotes database identifiers and waits for disconnect rather than terminating arbitrary sessions. Current callers generate narrow disposable names. A counted loop plus database sleeps is not a wall-clock deadline if a query stalls; keep ownership validation at the fixture and add bounded query behavior. |

## WQ-075 — diagnostics must not govern webhook acceptance

**P2 FIX/TEST; J01/J07/J08/J12.**
`webhooks/ingress.ts:87–92` delegates the entire handler directly to
`telemetry.trace`; `acceptWebhook` calls `telemetry.traceparent()` immediately
before acceptance without isolation. Counters already use `record` to contain
diagnostic errors. In `webhooks/telemetry.ts`, span status/end calls are also
unprotected, including `span.end()` in finally after successful work.

Local probes used real Fastify injection, a correctly signed body, an injected
database and encryption adapter, and current compiled ingress:

| Diagnostic behavior | HTTP | Durable acceptance calls |
| --- | ---: | ---: |
| All diagnostics succeed | 202 | 1 |
| Delivery counter throws | 202 | 1 |
| traceparent getter throws | 503 | 0 |
| Trace rejects before callback | 503 | 0 |

This proves inconsistent failure isolation at the public injected interface,
not that the ordinary OpenTelemetry SDK currently throws or that a real run was
duplicated. Use an at-most-once authoritative work promise as in WQ-064; contain
trace setup/status/end failures and treat unavailable traceparent as absent.
Never blindly repeat `acceptWebhook` after trace failure: it may have committed
or sent the response. Observe any trace promise rejection independently of the
business result. Keep error status on genuinely failed work when tracing works.

Tests: throws/rejects before callback, callback then throw/reject, callback
twice, span status/end failure, traceparent failure, and work failure concurrent
with diagnostics failure. Assert acceptance count at most one, unchanged exact
result/problem, no duplicate response, secret cleanup and no unhandled
rejection. Existing real parent/child span test must remain. For invalid/all-zero
parent IDs, use the tracing API's validity contract and test fallback explicitly;
do not turn audit-only request identifiers elsewhere into an unrelated tracing
rewrite. Implement with WQ-064 principles, without a new cross-feature framework.

## WQ-076 — make management material and output contracts explicit

**P2 REFACTOR/TEST; J02/J03/J06/J09.**
`webhooks/service.ts:64–145` computes operation-dependent `endpointBytes`,
`secretBytes`, `endpointKey`, `signingSecret`, `endpointHash` and
`secretVersionId`, then repeatedly rechecks undefined variants. Secret rotation
uses an inline throwing function inside the persistence argument:

```ts
endpointKeyHash: endpointHash ?? (() => {
  throw new Error('Webhook endpoint authentication is unavailable');
})(),
```

Give secret rotation a required endpoint key at its public service interface,
validated before random material or KMS work. Use explicit operation branches
or a small private discriminated prepared-material value so impossible material
combinations cannot reach dispatch. Prefer straightforward provision,
endpoint-rotation and secret-rotation bodies with a few shared private concepts
over a generic plugin/command dispatcher. Start cleanup ownership when the first
buffer is acquired, not after all generation, encoding and ID construction.
Preserve the caller's AbortSignal and pre-persistence abort check.

Required material is small enough to show directly:

| Operation | New endpoint | New signing secret | Supplied endpoint |
| --- | --- | --- | --- |
| Provision | yes | yes | no |
| Rotate endpoint | yes | no | no |
| Rotate secret | no | yes | required |

Do not include random material in provision/endpoint command hashes. Preserve
operation/workspace/workflow/trigger and endpoint-bound secret-rotation hash
bytes; actor scope is part of the database's idempotency scope, not missing
simply because it is absent from the webhook hash. Keep database authorization,
ADR-026's post-command endpoint/secret-version ownership proof and the rule
that completed replays never redisclose credentials. Failure of the proof read
after commit is an uncertain response, not permission to regenerate credentials
or report rollback. Avoid speculative replay caches or KMS elimination that
would change that contract.

`publicHealth` and `schedules/service.ts:89` currently spread database records.
Their current database projections are already bounded and contain no secrets;
there is **no demonstrated disclosure today**. Replace spreading with explicit
public fields and shared response types/schema validation so future storage
fields cannot silently become HTTP fields. Preserve null dates, exact ISO
representation and existing schedule recurrence. Do not move cron/DST or time
authority into the API. Make the two known schedule error variants explicit if
editing the mapper; do not invent new public errors for impossible variants.

Acceptance: each operation has exactly its required material; missing secret
rotation key fails before seal/database; generated buffers wiped on success,
seal failure, persistence failure, post-proof failure and abort; valid replay
returns no credentials; public responses satisfy the contract with extra fake
storage fields omitted. Run API typecheck and management/contract tests,
including WQ-053's generated replay-disclosure rule.

## WQ-077 — strengthen trigger unit evidence at actual interfaces

**P2 TEST; J04/J07/J12.** File-level work:

- `test/schedules/service.test.ts`: assert exact known request hash and prove
  changes to actor, operation, workspace, workflow and trigger change identity;
  request/trace metadata and idempotency key do not silently alter the intended
  hash. Test list success, empty list, enable/disable/replay, nullable/present
  dates and unknown error identity separately. The current regex proves only
  hash shape, not actor scoping.
- Add schedule controller/module/telemetry tests using the public registration
  and controller seams. Cover required key versus malformed/duplicate key,
  empty body validation, route IDs, actor forwarding, guard/CSRF composition,
  no mutation after denial, metric failures and work count once. Reuse existing
  real Nest helpers where they prove composition rather than adding a parallel
  framework. Keep database recurrence/scanner tests in their own package.
- `test/webhooks/service.test.ts`: return copied/captured input from a
  non-wiping seal fake so only the service can satisfy cleanup assertions.
  Use typed collaborators/complete valid return records; split the controller
  test into its own accurately named suite. For **each** operation assert exact
  field disclosure/absence, original versus completed replay, workflow parent
  forwarding and known/unknown errors. The provision replay test currently
  checks only `replayed`, then checks secret absence on rotate-secret instead.
  Cover list's schedule filtering and date projection, seal rejection, abort
  after seal, missing endpoint and failed ownership lookup after persistence.
- `test/webhooks/ingress.test.ts`: labeled independent authentication/admission
  error rows; valid signed invalid UTF-8; missing/duplicate/comma-folded timestamp,
  signature, content-type and idempotency headers through real raw-header
  transport when injection would normalize them. Assert endpoint limit before
  decrypt and **no** acceptance after denial. Test current/previous secret buffer
  wiping after second decrypt fails and after signature mismatch, and exact
  previous-secret deadline. Retain checking both eligible versions as the
  established verification policy, not an unmeasured optimization opportunity.
- Its socket-close test parks secret opening until an optional release callback.
  Put client destruction, required release and application close in finally so
  an earlier wait assertion cannot leave teardown hanging. Keep application
  ownership once; explicitly closing and then closing again in afterEach is
  unnecessary. Use a deferred barrier instead of optional release on success.
- `test/webhooks/telemetry.test.ts`: own SDK cleanup immediately after start;
  test absent/invalid parent and failed work alongside WQ-075. Keep real SDK
  propagation assertions. Ensure global SDK registration is isolated by the
  runner or explicitly cleaned up, not shared concurrently across test cases.

The existing accepted-reply serialization-failure test honestly expects 503;
add an assertion that acceptance already happened once and retry resolves the
existing run. A response failure after commit is not a database rollback.
Acceptance: each negative row reaches its named failure, exact calls/results,
no leaked socket or pending fake, and focused unit suites pass independently.

## WQ-078 — bound and isolate direct-webhook integration resources

**P2 FIX/TEST; J07/J10/J12/J14.**
`test/webhooks/direct-webhook.integration.test.ts` allocates pools/databases in
the describe callback rather than an executing fixture. `afterAll:264` awaits
application close before an allSettled list, so that first failure skips other
cleanup; the later allSettled results are discarded. A failed second release
probe acquisition also occurs before entering the probe cleanup try.

Move all resource acquisition into an awaited fixture with partial-failure
cleanup and a created-database ownership flag. Preserve runner-owned database
mode: it must not be dropped by this fixture. Use validated/quoted identifiers
for configured role names, not raw interpolation; the environment is trusted
configuration, so this is robustness and identifier correctness, not a claimed
remote SQL injection. Close application before its fixture-owned dependencies,
attempt independent closers with deferred thunks, collect failures, and still
close admin. Never terminate unrelated sessions or broaden cleanup beyond the
explicit disposable database.

`test/support/disposable-database.ts` waits up to 500 database sleeps of 20 ms,
but each preceding query and sleep query can itself block. Keep the safe
disconnected-only deletion strategy, add an actual deadline/query bound and
tests using an injected query client for connected/disconnected/missing-count/
query-failure/timeout cases. Assert exact quoted target, no DROP while clients
remain, and no session termination. Both current callers generate disposable
names; no unsafe deletion was performed or demonstrated by this audit.

`sendWebhook` collects unlimited response chunks, has no request/body deadline,
does not reject on response error/aborted/early close, and parses JSON inside
an event callback without catching parse failure. Use a bounded helper with
one settlement owner, request destruction on deadline, bounded bytes, caught
decode/parse errors and deterministic listener cleanup. Preserve the exact
outgoing raw signed bytes; do not use a helper that reserializes JSON.

Split the 60-second omnibus test into independently seeded stories: atomic
acceptance and replay, malformed authenticated body, rotation overlap, quota
rollback, outage response and disclosure checks. Keep concurrent exact replay
and exact delivery/run/event/checkpoint/outbox counts. The benchmark emits one
specific acceptance timing marker consumed by infrastructure; preserve that
named operation and metadata when splitting.

Correct leakage assertions: the final HMAC is regenerated using the current
second rather than retaining the signature actually sent; capture the actual
request material. Raw-body substring absence alone is weak when persisted JSON
normalizes whitespace or escapes strings. State which surfaces must exclude raw
bytes versus which intentionally contain parsed workflow input, and assert
exact allowed shapes/secret absence per surface. Keep queue payload's exact
reference-only key assertion. The forced outage fails immediately in an
injected verification adapter; elapsed <2 s does not prove a real PostgreSQL
timeout policy. Label it accurately and qualify actual timeout behavior
separately in the controlled service lane.

Acceptance: skipped collection allocates nothing; acquisition/cleanup failures
attempt all owned releases; helper rejects malformed/truncated/over-limit/stalled
responses without hanging; each story runs alone; service tests run only under
the explicit disposable integration gate. This review did not run migrations,
create/drop databases or establish deployed/KMS qualification.

## Shared runtime ownership finding

Extend WQ-065 to the two runtime files. In webhook close, `envelope.close()`
currently precedes `await database.close()` inside an async closure; a synchronous
envelope failure skips database cleanup. Defer each closer and aggregate errors
while caching the entire close promise. In schedule close, wrap invocation in a
deferred promise before assignment so a synchronous throw is cached too. Enclose
post-acquisition instrument/envelope construction in ownership-aware cleanup,
using an awaited factory if necessary; do not fire and forget pool shutdown.
Preserve injected and shared-lease ownership as defined by existing factories.
Add public-factory tests for synchronous/rejected closes, repeated close and
partial acquisition. Actual envelope close destroys KMS locally; no provider
call is required to exercise the ownership seam.

Order: WQ-075 and runtime cleanup first; WQ-076 in separate management-focused
units with WQ-077 regression cases; WQ-078 in the disposable-service lane. Keep
ADR-014/026 semantics and database authority unchanged throughout.
