# API platform, bootstrap and shared HTTP review

Date: 2026-09-12. Scope: 55 inventory files. Primary reviewer read every file
below in full. Feature runtimes and feature suites are recorded separately;
their imports here are not credited as completed feature reviews.

The API build passed. The API unit command ran **all 74 unit files / 672 tests**
successfully (its forwarded `--` did not narrow discovery). This is useful
regression evidence, not evidence that every API file has been reviewed.
Redis integration suites were read, not executed against a configured service.
Local probes used the freshly compiled API, real Nest composition, injected
resource ports and no provider/database/Redis connection.

## Individual file judgments

Paths are repository-relative. Criteria refer to J01–J14 in the main plan.

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `apps/api/package.json` | KEEP; existing PF-03 | Explicit build/start/typecheck and separate service gates; publisher coverage deliberately runs from repository root against queue source. Main-entrypoint evidence remains PF-03, not covered merely by the bootstrap suite. |
| `apps/api/src/app.module.ts` | FIX WQ-057; otherwise KEEP | Conditional feature registration expresses genuinely optional runtimes and shared identity ownership. Readiness composition and hook providers are visible; independently throwing shutdown providers are not an all-resource cleanup barrier. |
| `apps/api/src/app.ts` | FIX WQ-057; otherwise KEEP | Runtime-source unions plus runtime validation reject contradictory composition before acquisition. Pre-Nest cleanup thunks correctly catch synchronous close throws; post-Nest failure delegates to a close sequence that can skip owners. Do not split this into seven public builders. |
| `apps/api/src/application-error-mappers.ts` | KEEP | Ordered route table selects specific preview/run/connection paths before generic workflow/identity families. Unknown mapping falls through without inventing a feature code; path parsing strips queries. Table is more readable than another conditional chain. |
| `apps/api/src/main.ts` | FIX/TEST existing PF-02/PF-03 | Telemetry-first loading, listen ownership and process fallback belong to the existing entrypoint plan. Fatal diagnostics can precede cleanup; no duplicate new finding. |
| `apps/api/src/platform/config/api-config.ts` | KEEP; TEST WQ-059 | Explicit deployment/optional-local distinctions, proxy IP/CIDR admission and sanitized nested secret configuration are meaningful branches. Current-key validity is also checked by encryption construction. Keep Zod and the existing NodeNext build; strengthen targeted configuration evidence. |
| `apps/api/src/platform/database/database.module.ts` | FIX integration WQ-057; otherwise KEEP | Nest wrapper forwards workspace/readiness operations and release support without a service locator. Its shutdown registration must participate in failure-isolated application cleanup; do not duplicate database ownership in main. |
| `apps/api/src/platform/health/drain-state.ts` | KEEP; TEST WQ-058 | Monotonic drain flag, controller registration during drain, and idempotent release are compact. Set membership intentionally lasts until consumer release, not just abort request. |
| `apps/api/src/platform/health/live.controller.ts` | KEEP | Constant bounded liveness and explicit rate-limit exemption make no dependency-health claim. |
| `apps/api/src/platform/health/ready.controller.ts` | FIX WQ-058 | Distinguishes liveness from database/runtime readiness and hides dependency details, but fails to recheck drain after asynchronous health checks. |
| `apps/api/src/platform/http/application-error.ts` | FIX WQ-055 | Own-catalog membership avoids inherited catalog keys; the unknown-value predicate still executes `has` and property getters. Preserve frozen application-error values and stable codes. |
| `apps/api/src/platform/http/http.module.ts` | KEEP | One AsyncLocalStorage-backed context provider, use-existing alias and global filter registration are cohesive cross-cutting infrastructure. Mapper injection keeps feature error knowledge outside the HTTP module. |
| `apps/api/src/platform/http/idempotency-key.ts` | KEEP | Exact scalar/single-value parsing delegates printable-key validation to contracts and emits a distinct error. Empty/multiple/non-string values are intentionally different from picking the first header. |
| `apps/api/src/platform/http/index.ts` | KEEP | Small shared HTTP entrypoint exposes contracts and middleware without re-exporting domain features. |
| `apps/api/src/platform/http/problem-details.filter.ts` | FIX WQ-055; otherwise KEEP | Bounded messages/issues, metadata whitelisting, conflict validators, query stripping and sink isolation are purposeful complexity. Normalize/render/write phases are already named; do not flatten domain-specific metadata into an unchecked generic spread. |
| `apps/api/src/platform/http/request-context.ts` | KEEP | AsyncLocalStorage scopes mutable state while immutable snapshots prevent cross-request identity contamination; validation occurs when actor/workspace are set. Header fallbacks support Nest middleware and Fastify response surfaces. |
| `apps/api/src/platform/http/request-headers.ts` | KEEP | Raw, first-value and strict-single policies are separate on purpose. Case-insensitive header lookup is small; actual Fastify-normalized header input is not an arbitrary hostile-object seam. |
| `apps/api/src/platform/http/request-operation-signal.ts` | KEEP; TEST WQ-059 | Socket close plus request abort governs provider work; ignoring `raw.destroyed` alone is correct after normal body consumption. `finally` removes listeners. Timeout is cooperative cancellation, not proof that work stopped within 30 seconds. |
| `apps/api/src/platform/observability/api-metrics.ts` | KEEP; TEST WQ-059 | Closed problem-code sets and route templates avoid tenant/path labels; status-first availability logic gives all 5xx failures priority. WeakMaps avoid explicit request eviction. Do not collapse excluded quota and correctness failures into status-only counting. |
| `apps/api/src/platform/observability/observability.module.ts` | KEEP; WQ-057 integration | Delegates Nest lifecycle registration to the observability package. Telemetry ordering/failure isolation must be verified with the complete application owner, not changed independently here. |
| `apps/api/src/platform/observability/sse-visibility-metrics.ts` | KEEP; TEST WQ-059 | Injected wall clock, four-valued path and negative/non-finite observation exclusion are bounded. Caller owns first-frame cardinality; helper does not misleadingly deduplicate runs itself. |
| `apps/api/src/platform/rate-limit/interceptor.ts` | FIX WQ-056 | Metadata precedence, authorized-workspace preference and fail-open/closed policy are explicit. Metrics are invoked in all three authoritative branches and can replace their outcomes. |
| `apps/api/src/platform/rate-limit/metadata.ts` | KEEP | Separate exemption symbol prevents confusion with absent classification; method/class decorators share one metadata key. |
| `apps/api/src/platform/rate-limit/metrics.ts` | KEEP; WQ-056 regression seam | Records bounded dimensions without subjects. Keep instrument construction here; isolate recorder invocation where policy decisions are made. |
| `apps/api/src/platform/rate-limit/rate-limit.module.ts` | WQ-057 integration; otherwise KEEP | Owned Redis runtime has an explicit Nest close hook; injected consumer does not silently create Redis. Existing Redis close mechanics are WQ-001; application-wide hook failure isolation is WQ-057. |
| `apps/api/test/api-bootstrap.test.ts` | TEST/REFACTOR WQ-057–WQ-059; PF-03 | Real Nest/Fastify composition and real SSE socket are valuable. File interleaves composition, health, transport and feature behavior; a cleanup test asserts the error but not every remaining owner. SSE readiness/timeout/client cleanup need structured ownership. |
| `apps/api/test/api-config.test.ts` | TEST WQ-059 | Covers complete deployed config and specific sanitized failures. Missing independent production-OTLP/proxy/session/key-list cases; one complete fixture with one changed input per rejection makes intent clearer. |
| `apps/api/test/feature-import-boundaries.test.ts` | KEEP with scope limit | Five exact forbidden import spellings are transparent narrow guardrails, not a complete dependency graph or protection against every alternate relative spelling. Preserve unless expanding the stated boundary contract. |
| `apps/api/test/http/problem-details.filter.test.ts` | TEST WQ-055/WQ-059 | Asserts actual safe bodies, headers, framework-before-feature precedence and sync/async logger isolation. Add hostile normalization; split independent malformed ETag/revision negatives currently combined. |
| `apps/api/test/http/request-context.test.ts` | KEEP; TEST WQ-059 | Concurrent promise work exercises actual AsyncLocalStorage isolation and frozen actor snapshots. The valid-ID test says “echoes” but stubs away the response-header assertion. |
| `apps/api/test/http/request-headers.test.ts` | KEEP | Small direct policy examples cover raw lookup, missing values, first selection and rejection of ambiguous/mistyped singleton values. |
| `apps/api/test/orchestration-coverage-config.test.ts` | KEEP; PF-03 extension | Exact cohort/source-root assertions guard deliberate coverage routing. These assert configuration, not behavioral sufficiency or cross-cohort disjointness. |
| `apps/api/test/platform/http/request-operation-signal.test.ts` | TEST WQ-059 | Correctly distinguishes consumed body from closed socket; add work rejection, request-aborted event and controlled timeout cleanup assertions. |
| `apps/api/test/platform/observability/api-metrics.test.ts` | TEST/REFACTOR WQ-059 | One 224-line scenario covers several unrelated outcomes using optional hook calls. Separate named policy cases and assert complete callback/duration behavior, not merely record count. |
| `apps/api/test/platform/observability/sse-visibility-metrics.test.ts` | TEST WQ-059 | Exact 2.5-second sample and future-clock exclusion are strong. Extend non-finite dates/clocks, zero latency and all path values; avoid substring privacy checks as a substitute for exact attributes. |
| `apps/api/test/rate-limit/distributed-rate-limiter.integration.test.ts` | FIX/TEST WQ-060; TEST WQ-059 | Exact concurrent admission, real TTL and reconnect coverage are useful. Broad `CLIENT KILL TYPE normal` is not scoped to the test client; initialization cleanup can dereference an unassigned limiter. Elapsed batch time / request count is not individual request latency. |
| `apps/api/test/rate-limit/interceptor.test.ts` | TEST WQ-056; otherwise KEEP | Public interceptor tests prove no controller work after rejection, permitted fail-open, selected dimensions and authorized-scope precedence. Missing recorder-failure matrix is consequential. |
| `apps/api/test/rate-limit/multidimensional-rate-limiter.integration.test.ts` | KEEP | Precharging one dimension then independently probing every other counter proves rejection atomicity; concurrent combined acceptance verifies exact remaining capacity. Service-backed gate intentionally separate from units. |
| `apps/api/test/rate-limit/rate-limit.module.test.ts` | KEEP; WQ-057 application evidence elsewhere | Verifies override identity and owned lazy runtime shutdown. Reflection narrowing is acceptable at the provider inspection seam; test does not claim a live Redis connection. |
| `apps/api/test/rate-limit/route-classification.test.ts` | TEST WQ-059 | Explicit expected table is readable but incomplete: no artifact controllers and newer authoring operations are outside it. A declared table alone cannot detect newly added unclassified handlers. |
| `apps/api/test/rate-limit/trusted-proxy.test.ts` | REFACTOR WQ-059; otherwise KEEP | Real Fastify probes verify nearest untrusted hop and untrusted direct peer. Primitive JSON coercion is unrelated to the proxy suite and should have an accurately named transport-validation home. |
| `apps/api/test/response-contract-types.test.ts` | KEEP | Exact output/request types guard compatibility rather than broad assignability. Keep tsc execution: runtime Vitest success alone does not prove these type assertions. |
| `apps/api/test/support/api-platform.fixture.ts` | KEEP | Explicit fail-if-used operations and stub runtime ownership keep tests local. `withWorkspace(undefined as never)` is a bootstrap-only fake, not evidence of RLS or transactions. |
| `apps/api/test/support/integration-gate.test.ts` | KEEP | Distinguishes intentionally skipped gates from requested missing/blank configuration without echoing credentials. |
| `apps/api/test/support/integration-gate.ts` | KEEP; not a WQ-060 safety gate | Checks requested configuration presence and reports key names only. It intentionally says nothing about whether a service is disposable; do not treat existence as authorization for fault injection. |
| `apps/api/tsconfig.json` | KEEP | Explicit NodeNext composite build and package references preserve framework decorator/type metadata and package export contracts. |
| `apps/api/tsconfig.test.json` | KEEP | Adds test root/noEmit without altering production build. Additional cohort configs imported by orchestration tests are transitively typechecked; omission from the direct include list alone is not a bug. |
| `apps/api/vitest.compatibility-rollout.config.ts` | KEEP | Serial single-purpose database rollout cohort with explicit test selection. Execution evidence belongs to its later feature/infrastructure review. |
| `apps/api/vitest.config.ts` | KEEP | Unit discovery excludes service integration files and generated/dependency output. |
| `apps/api/vitest.coverage.config.ts` | KEEP; PF-03 | Explicit security-boundary cohort and publisher exclusion; thresholds are gates, not proof of exhaustive behavior. |
| `apps/api/vitest.integration.config.ts` | KEEP | Includes service integration tests with hook/test bounds and excludes long resilience cohort. |
| `apps/api/vitest.orchestration-coverage.config.ts` | KEEP | Named orchestration files and separate output directory avoid publisher double measurement within this cohort. |
| `apps/api/vitest.priority-coverage.config.ts` | KEEP | Explicit priority source list and webhook-specific floor preserve existing coverage intent; no blanket threshold lowering. |
| `apps/api/vitest.run-event-publisher-coverage.config.ts` | KEEP | Repository-root alias measures canonical queue source rather than API re-export shim; matching script/report paths were inspected. |
| `apps/api/vitest.sse-resilience.config.ts` | KEEP | Separate single-worker fault/recovery transport suite legitimately needs longer bounds than unit tests. |

## WQ-055 — make unknown-error normalization fail closed

**P2 FIX/TEST; J06/J08/J09.** At `http/application-error.ts:39`, this is not a
safe predicate over every JavaScript rejection:

```ts
if (typeof value !== 'object' || value === null || !('code' in value))
  return false;
const code = value.code;
```

`problem-details.filter.ts:380` invokes normalization without a fallback guard.
Even a value with a recognized `code` can throw when `safeDetail`, `details` or
`cause` is read. A local probe of the exported filter with (a) a throwing
Proxy `has` trap and (b) a throwing `safeDetail` getter reproduced a secondary
exception with **zero response sends**. This is an in-process unknown-error
boundary defect, not a claim that a remote JSON body can contain a Proxy.

Change the predicate to return false if inspection fails. Enclose the full
normalization/projection phase in a private fail-closed boundary that returns
a locally constructed `internal.unexpected` problem without rereading the
hostile value. Retain the original opaque rejection as the diagnostic cause;
the already-isolated logger may receive it. Do not catch transport writes and
attempt a second response. Preserve application-error → framework exception →
feature mapper → generic Zod → internal fallback precedence, safe metadata
whitelists, valid conflict headers and bounded issue lists. Validate that
framework status is an integer in 400–599 before handing it to Fastify.

Tests: throwing `has`/`get`/`getPrototypeOf`, revoked Proxy, known code with
throwing optional metadata, throwing injected mapper, fractional/NaN framework
status. Each must send one valid safe 500 and not expose the secondary error.
Existing ordinary framework/application/Zod cases must remain unchanged.
Acceptance: filter unit cases plus real Nest request rejection; no new shared
error framework. Implement independently before broad test reorganization.

## WQ-056 — keep rate-limit diagnostics outside policy authority

**P2 FIX/TEST; J01/J08.** `rate-limit/interceptor.ts:111,124,136` invokes
`metrics.record` before resolving the Redis-error, limited and allowed paths.
The recorder port is injected and the call has no isolation. Probes through
the actual interceptor with a throwing recorder produced its error for all
three cases: authenticated read + Redis failure never reached its permitted
fail-open handler; allowed provider test never reached its handler; limited
provider test lost the stable `request.rate_limited` outcome.

Use a small private non-throwing recorder invocation at this seam. Do not wrap
`consumer.consume` and `next.handle` in the same catch, change policy budgets,
reconsume a token, or turn every Redis error into fail-open behavior. The
recorder is synchronous by contract; no new asynchronous sink framework is
needed. Preserve ordinary metrics attributes exactly.

Tests in `test/rate-limit/interceptor.test.ts`: for recorder throw, allowed
calls handler once, limited calls it zero times and retains retry metadata,
Redis failure follows the selected open/closed policy, exempt bypasses
consumer/recorder, unclassified still rejects. Acceptance: exact stable error
identity/code and controller call count under each case, then real HTTP 429
and 503 assertions. Independent of PF-03's bootstrap telemetry fixes.

## WQ-057 — application close must attempt every owned resource

**P1 FIX/TEST; J07/J08.** `app.ts:247–268` hands lifecycle ownership to Nest
and uses `application.close()` after initialization/readiness failure.
Feature runtime modules and `app.module.ts` expose independently throwing
`onApplicationShutdown` hooks. Pinned Nest 11.2.1 iterates modules sequentially
in `callShutdownHook`; a rejection stops later modules. `close()` also only
unsubscribes process signal listeners after all hooks succeed.

A probe built the real application with injected database, identity and
workflow ports. When workflow close rejected, attempted closes were only
`telemetry, workflow`: **database and identity were skipped**, with one extra
SIGTERM listener retained. The same occurred when compatibility failed first
and the startup catch called close. A rejecting last identity hook did not
skip already-closed owners; failure position matters. Existing tests for an
identity close rejection assert the aggregate but not completeness of cleanup.

Implement a private, API-owned shutdown coordination seam so resource-close
failures cannot stop invocation of other owners. Keep acquisition/closure
inside the API composition layer, never duplicate it in main and never move
it into a generic cross-app lifecycle framework. Preserve this order:

1. Mark draining and abort registered SSE consumers; finish their cleanup.
2. Stop/dispose the HTTP listener through supported Nest lifecycle APIs.
3. Attempt every registered resource close, catching synchronous throws as
   well as rejections, and wait for all attempts to settle.
4. Complete lifecycle/listener cleanup and surface the original failure plus
   all close failures without losing an `undefined` rejection.

The exact hook integration must be proven against the pinned Nest lifecycle
for both explicit `application.close()` and process signals. Merely adding
`Promise.allSettled` inside each feature runtime, a wrapper around explicit
close only, or an aggregate throw from an early hook is insufficient. Do not
reach into private Nest fields or silently turn failed cleanup into success.
Use the existing runtime close idempotence and explicit transfer-of-ownership
boundary; no double database pool close or feature disposal while SSE uses it.

Tests: early/middle/last resource rejects; synchronous throw; several failures;
one slow close held by a barrier; compatibility/init failure; explicit close;
compiled SIGTERM child. Assert every acquired owner called once, none before
drain/transport disposal, all settled before terminal outcome, original error
first, no remaining app signal listeners, and no hanging process. Reuse
PF-03's app-owned process test seam when implemented. This new finding
supersedes the old structural ledger's unconditional `app.ts` KEEP only for
failure-isolated shutdown; the existing acquisition owner remains correct.

## WQ-058 — do not report ready after drain began during a health check

**P2 FIX/TEST; J01/J07.** `health/ready.controller.ts:37–47` checks drain only
before awaiting dependencies. A deferred-check probe called `ready()`, then
`beginDrain()`, then resolved the check: result was `{status:'ready'}` while
`isDraining()` was true. This is a stale in-flight readiness response, not
proof that post-drain business requests bypass authorization.

Recheck the monotonic drain flag after the successful await and before
returning `READY_RESPONSE`; use the same bounded 503 behavior. No timer or
global lock is needed. In the health/bootstrap tests hold readiness with a
deferred promise, begin drain, resolve it, and assert 503 without dependency
details. Also cover normal ready, initially draining without dependency work,
rejection, and late stream registration/release during drain. Implement beside
WQ-057 but keep this small independent behavior change reviewable.

## WQ-059 — make platform tests easier to read and more discriminating

**P2 TEST/REFACTOR; J02/J04/J12/J13.** This is concrete test work, not a request
to shorten every suite or raise coverage percentages without behavior:

- `api-bootstrap.test.ts:563–672`: real SSE client has no error-to-rejection
  path on the startup barrier; its losing one-second race timer is not cleared
  and `client.destroy()` is success-only. Use a bounded readiness promise with
  error/early-end rejection and `finally` for client/timer/application cleanup.
  Keep the real socket. Divide bootstrap ownership/health tests from feature
  composition and SSE transport into named suites with one fixture owner;
  do not duplicate the large identity fake per file. Add WQ-057's complete
  close matrix before reorganizing it.
- `api-config.test.ts`: start from one known-valid deployed environment and
  vary production OTLP omission, proxy omission/invalid IPv6 prefix, insecure
  cookie, SameSite=None, malformed previous-key JSON and disallowed algorithm
  independently. Assert sanitized errors, not unrelated earlier failures.
  Also test development HTTP OIDC expectations at actual adapter composition;
  the config flag, not this parser alone, enforces test-only insecure OIDC.
- `problem-details.filter.test.ts`: separate invalid current revision with
  valid ETag from invalid ETag with valid revision; cover empty/100/101 issues,
  escaped `~` and `/` segments, all retry bounds and WQ-055. Keep typed response
  schema assertions and sync/async logging tests. Group normalization,
  conflict metadata, mapping precedence and transport projection by subject.
- `request-context.test.ts`: capture response headers in the valid-ID case
  and assert both echoed `x-request-id` and request-attached ID; the current
  no-op header stub does not prove the test title.
- `request-operation-signal.test.ts`: add request `aborted`, rejected and
  synchronously throwing work, successful work, and a controlled timeout
  signal (restore any static spy). Assert both listener counts return to zero;
  no 30-second real sleep. Keep the healthy consumed-body regression.
- `api-metrics.test.ts`: replace its one long scenario with named rows for
  success, business conflict, auth/input exclusion, tenant quota, generic
  backpressure, correctness failure, 5xx, both health routes and unmatched.
  Assert registered hooks exist before invoking them, onSend preserves the
  exact payload, callbacks run once, malformed/oversized/non-string problem
  payloads get bounded labels, and a controlled monotonic clock yields the
  exact duration. Keep the manifest-wide 5xx loop as a meaningful invariant.
- `sse-visibility-metrics.test.ts`: exact attributes for four paths, invalid
  date/non-finite injected clock, zero latency and future timestamp; ensure
  mutually exclusive histogram/skew recording.
- `route-classification.test.ts:30`: retain the human-written expected
  policies, but cross-check against discovered mounted controller handlers so
  omissions fail. Include artifact upload/finalize/download handlers and
  authoring lifecycle/restore handlers. Assert method override of class policy
  and health exemptions. Raw webhook ingress is a separate policy owner and
  should not be spuriously required to carry Nest metadata.
- `trusted-proxy.test.ts:53`: relocate primitive JSON coercion to a small
  HTTP-validation suite; it is a useful framework regression, not proxy logic.
- `distributed-rate-limiter.integration.test.ts:137–149`: total concurrent
  batch time / 550 is throughput-derived time, not request latency; moreover
  `< 10000` already implies `/550 < 20`. Remove the redundant “latency” check
  or explicitly measure each quiet request's end-to-end latency and label it
  accurately. Keep exact admission assertions and real Redis TTL evidence.

Acceptance: independently named failed scenario, fresh/owned fixtures, no
test-only arbitrary microtask flush loops, same behavioral coverage, API unit
and typecheck pass, service evidence labeled separately. Existing local CI
output/report paths and strict coverage floors must not be lowered to make
reorganization pass. Implement after the bug regressions, grouped by behavior.

## WQ-060 — scope Redis fault injection and own partial test startup

**P2 FIX/TEST; J07/J09/J12.** The reconnect case at
`test/rate-limit/distributed-rate-limiter.integration.test.ts:56` uses:

```ts
await redis.call('CLIENT', 'KILL', 'TYPE', 'normal', 'SKIPME', 'yes');
```

This disconnects every normal connection except the control client, not only
this test's limiter. Its only local gate is a requested flag plus a nonblank
`REDIS_URL`; that is not evidence of an isolated disposable instance. Normal
CI/local launchers set the gate, but their full service isolation will be
reviewed in infrastructure. No broad kill was executed during this audit.

Run this chaos case on a dedicated disposable Redis fixture, or fault only a
fixture-owned TCP connection through a local proxy. Do not select “all clients
except me,” assume a logical Redis DB isolates connections, expose private
production client state, or add a production abstraction solely for the test.
Require explicit isolation evidence before the fault, and keep an unrelated
sentinel connection alive as a regression assertion when using targeted fault.

Also make beforeAll/afterAll ownership safe: Redis connect/ping can reject
before `limiter` is assigned; current `await limiter.close()` then throws and
skips Redis cleanup. Track optional acquired resources and use independent
close thunks with `finally`/all-settled semantics. Preserve the original setup
failure and any cleanup errors. Coordinate Redis close rejection fallback
with WQ-001 without claiming that its conditional leak is already proven.

Acceptance: startup failure at allocation/connect/ping/limiter creation leaves
no owned socket; controlled disconnect makes the real limiter reconnect;
sentinel remains usable; missing isolation fails before any fault command.
Integrate service setup with the existing local/CI runner after those files
are reviewed. This is test-infrastructure safety, not a production outage claim.

## Implementation order and retained complexity

1. WQ-057 resource completeness and its process evidence, coordinated with
   existing PF-02/PF-03; WQ-058 can be a small adjacent health behavior change.
2. Independent WQ-055 and WQ-056 regressions/fixes.
3. WQ-060 before running destructive Redis fault qualification.
4. WQ-059 test organization and discrimination, preserving each new regression.

Retain optional-runtime unions, ordered feature-error table, separate header
policies, monotonic drain state, bounded problem projection, real socket tests
and explicit fail-open/closed decisions. Their condition count is not itself
a defect. No source implementation, commit, push or external service mutation
was performed for this review.
