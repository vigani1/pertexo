# API artifacts and catalog review

Date: 2026-09-12. Scope: 21 frozen inventory files, each read in full by the
primary reviewer. This includes the service-backed artifact transfer suite and
its 878-line support fixture, not just the production service. Current API
build, typecheck and 74 unit files / 672 tests passed during this review.
Service-backed transfers were **not executed**. Existing S3Mock region-probe
bypass is explicit in the fixture and is not deployed region-isolation proof.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `apps/api/src/artifacts/controllers.ts` | KEEP; WQ-059 metadata coverage | Thin routes validate identifiers, establish authenticated actor context, require mutation CSRF/idempotency and give provider work a disconnect/timeout signal. All four responses have no-store headers. Repeated decorator policy is useful local visibility, not a reason for a custom decorator framework. |
| `apps/api/src/artifacts/errors.ts` | KEEP; WQ-061 integration | Stable typed mapping distinguishes invalid declarations, hidden resources, quota, replay conflict, lifecycle conflict and outage. No provider message substring heuristics. Shared unknown-value normalization is WQ-055; recheck denial must reach this mapper intact. |
| `apps/api/src/artifacts/guards.ts` | KEEP | Upload/read are distinct capabilities, active-workspace-only and concealed as not-found. Small subclasses state route policy over the common authorization guard. |
| `apps/api/src/artifacts/index.ts` | KEEP | Feature-owned exports group controllers/service/ports/errors/tokens; runtime composition remains server-side. |
| `apps/api/src/artifacts/module.ts` | KEEP | Explicit three-port injection, shared identity-module import, service construction options and two capability guards. No duplicated provider instances hidden behind factory calls per request. |
| `apps/api/src/artifacts/ports.ts` | KEEP | Database operations/metadata are picked from the persistence contract; service receives operations without lifecycle authority. Context explicitly carries actor, route tenant, optional established guard context and signal. |
| `apps/api/src/artifacts/service.ts` | FIX WQ-061; otherwise KEEP | Reservation → signing and load → verification → finalize phases preserve ADR 035. Available replay cannot remint PUT, original deadline bounds signing, metadata strips storage keys, downloads require available status. Post-verification authorization is essential; broad database error remapping loses its denial. |
| `apps/api/src/artifacts/store-port.ts` | KEEP | Pick from the real dual-region store ties API signatures to one contract without hand-copying provider capabilities. |
| `apps/api/src/artifacts/tokens.ts` | KEEP | Three distinct symbol tokens match the three DI ports; tiny identity module is justified by Nest wiring. |
| `apps/api/src/platform/artifacts/artifact-runtime.module.ts` | KEEP local owner; WQ-057 application integration | Store-first acquisition catches database construction failure; deferred close thunks attempt both resources on synchronous throw, aggregate failures and cache the close promise. Store close is synchronous by its real contract. Per-runtime correctness does not fix cross-module Nest shutdown. |
| `apps/api/src/catalog/controllers.ts` | KEEP | Both authenticated read routes validate a strict empty query before executing discovery; no accidental arbitrary filters. |
| `apps/api/src/catalog/index.ts` | KEEP | Narrow entrypoint exports only the module needed by root composition. |
| `apps/api/src/catalog/module.ts` | KEEP | Constructs catalog/use cases once at module registration with explicit class tokens and identity import. Static catalog does not require a database/provider service. |
| `apps/api/src/catalog/use-cases.ts` | REFACTOR/TEST WQ-063 | Grouping by provider/operation and numeric-version sorting are legitimate. Four nested ternary comparisons make simple lexical tie-breaking harder to read; the “each request only serializes” comment overstates what integration execution does. No unmeasured caching proposal. |
| `apps/api/test/artifacts/controllers.test.ts` | KEEP; TEST WQ-062 | Exercises actor/trace projection and ambiguous idempotency rejection before delegation. Replace `{ } as never` success with a valid response fixture and cover remaining route forwarding; current direct tests are not proof of guard execution. |
| `apps/api/test/artifacts/runtime.test.ts` | KEEP; TEST WQ-062 | Good real shared-runtime forwarding, once-only close, sync database-close throw and constructor+cleanup aggregate cases. Put fixture construction/use inside ownership-safe try/finally so assertion failure does not leak a runtime. |
| `apps/api/test/artifacts/service.test.ts` | TEST WQ-061/WQ-062 | Recheck test uses only `.rejects.toThrow()`, which passes for the wrong outage. Fake callback correctly precedes available result but should assert commit was not reached. Deadline/status/error/metadata negative cases need explicit variants. |
| `apps/api/test/artifacts/transfer.integration.test.ts` | TEST/REFACTOR WQ-062 | Real HTTP/SQL/storage evidence covers admission, immutable PUT fallback verification, dual-region finalize, deletion races and capacity truth. Long tests combine unrelated scenarios and share mutable capacity; cleanup/restoration is not failure-safe in every case. Keep real provider acceptance differences explicit. |
| `apps/api/test/support/artifact-transfer.integration.support.ts` | FIX/REFACTOR WQ-062 | Scoped parameterized fixture SQL and owner-role quoting are sound. Acquisition awaits identity creation before entering cleanup try; cleanup swallows every error and concurrently closes aliases owned by the application. Logs are module-global rather than fixture-owned. |
| `apps/api/test/catalog/controller.test.ts` | TEST WQ-063 | Exact response schemas and guard metadata checks are useful. `localeCompare` is not the production ordinal comparator; function-type assertions do not prove Nest resolution, grouping or per-version flag aggregation. |
| `apps/api/test/catalog/module.test.ts` | KEEP; TEST WQ-063 | Asserts returned dynamic-module metadata honestly. Add actual Nest resolution only if retaining the other test's stronger resolution claim; do not count `provide` presence as instantiated DI proof. |

## WQ-061 — preserve authorization failure across artifact verification

**P2 FIX/TEST; J01/J08/J09.** `artifacts/service.ts:145–164` deliberately
reauthorizes after object-store verification, inside the database's
`verifyUpload` callback. Its enclosing catch passes every rejection to
`mapDatabaseError` at line 277, which recognizes artifact errors but not
`AuthorizationError`; the fallback returns `ArtifactApiUnavailableError`.

The actual persistence implementation at
`packages/database/src/execution/artifact-upload.ts:328–361` awaits that
callback before completing finalization. Its destructive-operation lock
wrapper preserves an ordinary Error when the operation fails and unlock
succeeds. A current compiled service probe with an initially active owner,
then missing membership at recheck, produced:

```text
authorization calls: 2
finalization commit reached: false
error: ArtifactApiUnavailableError
public mapping: artifact.unavailable
```

This is a false storage-outage/503 response and lost authorization diagnosis,
**not an authorization bypass or an available artifact committed after denial**.
The existing regression only expects any thrown error and therefore passes.

Keep the callback recheck where it belongs and preserve its typed authorization
failure across the outer mapping boundary. A small explicit pass-through for
the established authorization error is sufficient; do not allow arbitrary
provider errors through, infer authorization from message text, or move
provider I/O into the final SQL transaction. Keep existing disclosure policy:
initial HTTP artifact guards hide inaccessible resources as 404; the service's
authorization error retains the code chosen by its authorization seam. Do not
silently change that policy while fixing the false outage.

Test changes: in `service.test.ts`, assert the exact authorization code, two
lookups, verification once, and no fake commit after the callback rejects.
Cover active→missing, active→inactive membership, active→suspended workspace,
and lost capability; verify genuine storage failure still maps to outage and
integrity failure to conflict. In the real transfer suite, use the existing
after-verification callback to change one membership/state, assert the agreed
safe HTTP denial, pending artifact and unchanged capacity. Restore fixture
state in `finally` even if the assertion fails.

Acceptance: typed denial survives verification/persistence mapping without
weakening the database's final authorization/state checks, no misleading
artifact outage for this scenario, API unit/typecheck plus gated transfer
evidence. No ADR change: this restores the existing authorization contract.

## WQ-062 — artifact fixture ownership and test discrimination

**P2 FIX/TEST/REFACTOR; J02/J07/J12/J14.** Concrete work by file:

### Support fixture and teardown

`artifact-transfer.integration.support.ts:261` constructs three database
owners, then awaits three identity resolutions at lines 285–287, before the
cleanup try. A rejection there leaves acquired database owners outside any
close path. The integration suite's `let fixture!` and unconditional
`fixture.close()` also produce a second error when creation failed.

Begin the try at first acquisition; retain optional acquired owners in a
private fixture construction scope, including both ordinary and fresh-service
construction paths. Record transfer to the application explicitly. After
successful construction close the application first and then only remaining
fixture-owned stores/pools; do not concurrently close its aliased database and
verification store while Nest is draining. Coordinate with WQ-057 so a failed
application close cannot skip remaining fixture cleanup. Aggregate cleanup
errors rather than discarding `Promise.allSettled` results at lines 570/588/816.
Protect every close invocation against synchronous throw. Fixture `close`
should be once-only and preserve original setup failure plus cleanup failures.

Move `logLines` and its logger into fixture scope; fresh instances should have
an explicit shared-capture owner if that is what the redaction test intends.
Keep SQL parameterization, scoped role/tenant setup and fixed test identities.
This fixture does not drop its database or delete every created object; its
service-runner disposal responsibility must remain explicit in infrastructure
qualification. Do not add broad cleanup against an arbitrary configured URL.

Tests for the fixture owner can inject failing allocation/setup/close steps
through a small test-local construction helper; preserve at least one path
using the real API and real disposable backing services. Verify identity
resolution failure, second store failure, application failure, several close
failures and held cleanup barrier. Assert all and only acquired owners close,
once, with no success result when cleanup failed.

### Service/controller/runtime suites

- `service.test.ts`: supplement WQ-061 with pending/deleting/deleted/available
  decisions, missing artifact, exactly 59/60/900 remaining signing seconds,
  expired finalize, quota/idempotency/database errors and pending-download
  denial. Assert no capability is minted on rejected states and exact public
  metadata omits storage key/purpose. Use a commit marker after `verifyUpload`
  rather than treating invocation of `finalizeUpload` as durable success.
- `controllers.test.ts`: use the existing real-shaped upload response fixture
  instead of `{ } as never`; assert finalize/download signal and route identity
  projection, plus metadata delegation. Keep guard/CSRF proof in composed HTTP
  tests, not direct controller method calls.
- `runtime.test.ts`: ensure both the shared runtime and created API runtime
  close in `finally` when an assertion fails. Add both-close failure aggregation
  and repeated rejection caching, without replacing the valuable real shared
  database-runtime forwarding test with a fake factory-only assertion.

### Transfer suite

- Separate denials into named rows with the exact problem code and the same
  baseline persistence/storage assertions. Preserve mutation versus read
  policy and pending-deletion session-revocation behavior.
- Separate quota racing from missing/divergent/expired object scenarios. Wrap
  `setCapacity` at lines 516–545 in `try/finally`; a failed assertion must not
  leave the suite's shared workspace at the reduced limit.
- Keep the end-to-end successful transfer as one coherent story, but name
  independently failing immutable-header scenarios. The current helper may
  legitimately accept either provider rejection or independent API rejection;
  do not pretend the mock qualifies real signed-header enforcement. Preserve
  response body cancellation and use bounded request signals for fixture
  fetches so Vitest timeouts do not leave transport work running.
- Reuse shared contract response types or parsers instead of independently
  copied `ArtifactMetadata`/`UploadCapability`/`UploadResponse` types. A typed
  `response.json<T>()` assertion alone does not validate received JSON.
- Keep real SQL capacity snapshots, deletion-race barriers, dual-region
  verification and signed-URL persistence/log checks. The final retention
  test manually writes `deleted` after physical deletion: it proves the
  database charge transition, not that the production retention worker ran.

Acceptance: individual failures are identifiable; fresh/owned fixtures cannot
pollute subsequent cases; all unit/type checks stay green; gated service suite
preserves its ADR 035 evidence and reports the S3Mock limitations accurately.
Implement ownership first, WQ-061 regression next, then test reorganization.

## WQ-063 — simplify catalog ordering and test its actual contract

**P3 REFACTOR/TEST; J02/J04/J12.** `catalog/use-cases.ts:84–107` implements
provider/operation and definition key/version ordering using nested ternaries:

```ts
return left.providerKey < right.providerKey ? -1
  : left.providerKey > right.providerKey ? 1
  : left.operationKey < right.operationKey ? -1
  : left.operationKey > right.operationKey ? 1 : 0;
```

Use a private ordinal string comparator and named tie-breaks or simple early
returns; preserve JavaScript ordinal ordering and numeric version ordering.
For example, `byProvider || compareOrdinal(left.operationKey,
right.operationKey)` is clearer once `byProvider` is explicitly numeric. Do
not replace this with locale-dependent sorting or pull in a general utility
dependency. Keep grouped operation identity and availability/publishability
as independent `some` reductions.

Correct the line 110 comment: the browser catalog is constructed once, but
integration execution still groups, sorts and validates the projection on
each request. No measured latency problem justifies a cache or shared mutable
response optimization here.

In `test/catalog/controller.test.ts:45`, replace localeCompare-based expected
sorting with explicit expected order for a deliberately shuffled custom
catalog. Include multiple definitions for the same provider/operation, numeric
versions such as 2 and 10, multiple operations, a non-integration definition,
and differing availability/publishability flags. Assert merged identities,
ordering and flags, not just presence of three current providers. Verify
returned response mutation cannot alter later discovery results.

The “exposes explicit use-case providers for Nest resolution” test only checks
that imported classes are functions. Either describe that narrow fact
honestly and remove the low-value assertion, or replace it with a small Nest
module compilation/resolution test using the supplied identity module. Retain
the module metadata test and real root-app discovery/authentication evidence.

Acceptance: same current cohort responses and release identity; deterministic
ordinal order independent of locale; grouping/version/flag regression passes;
no new public seam or speculative performance claim. Implement after the
correctness and fixture-ownership work.

## Contracts intentionally retained

ADR 035 was read in full for this review. Keep direct signed transfer, its
accepted short bearer-capability revocation window, no-store responses,
advisory-lock serialization outside transactions, immutable reservation
metadata, exactly charged pending/available/deleting states, and no new PUT
for an already available upload. Source inspection of the database callback
and lock helper is supporting evidence only; those whole database files await
their own complete review ledger.
