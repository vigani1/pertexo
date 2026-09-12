# API connections review

Date: 2026-09-12. Scope: 23 frozen inventory files, read in full by the primary
reviewer. `pnpm --filter @pertexo/api exec vitest run test/connections` passed
8 files / 66 tests. Probes used compiled current code, injected collaborators
and unconnected local pools; no provider, Redis or PostgreSQL request ran.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `apps/api/src/connections/authorization.ts` | KEEP; TEST WQ-067 | Active-workspace capability checks conceal access as not-found. Ordinary operations reuse established guard context; credential egress deliberately re-reads membership after durable intent. These are different security phases, not redundant lookups. |
| `apps/api/src/connections/connection-testing.ts` | KEEP structure; TEST WQ-067 | Replay precedes secret access; dispatch evidence is passed into provider clients; plaintext and HTTP bodies are cleared. Email disclosure is schema-enforced before intent and the provider idempotency key is stable. Provider-specific switches carry real differences; do not compress them into a loosely typed generic dispatcher. Cleanup-error preservation needs a small correction under WQ-067. |
| `apps/api/src/connections/controllers.ts` | REFACTOR WQ-066; TEST WQ-067 | Route parsing and explicit auth/capability/CSRF decorators are readable. Create/rotate/test wrap request cancellation. Four private context wrappers repeat an existing projection and split actor from identifiers; use the existing projection directly. Revoke has no long provider operation and does not need speculative cancellation plumbing. |
| `apps/api/src/connections/errors.ts` | KEEP; TEST WQ-067 | Typed database/provider mappings preserve safe public vocabulary. Several checks are legitimate precedence, not excessive branching. WQ-055 owns unknown-value mapper failure containment at the global filter; do not implement hostile-object guards independently in every feature mapper. |
| `apps/api/src/connections/failure-notification-destinations.ts` | REFACTOR WQ-066; TEST WQ-067 | Seven typed application operations are a reasonable single use-case interface. Transport projection, validation/decorators and persistence projection are mixed in one file; request metadata also diverges from the established shared projection. Transactional database authorization already exists, so lack of an API authorization dependency is not an asserted bypass. |
| `apps/api/src/connections/guards.ts` | KEEP | Three small subclasses express manage/use/workflow-update authority over the shared guard; active-only and not-found disclosure remain locally visible. |
| `apps/api/src/connections/index.ts` | KEEP; adjust WQ-066 exports | Feature barrel groups the intended composition surface. Preserve existing imports when moving destination controller/use cases. |
| `apps/api/src/connections/module.ts` | KEEP; TEST WQ-067 | Explicit dependencies build use cases once; identity is imported rather than recreated. Optional destination persistence controls both provider and route mounting. Preserve that coupled condition instead of treating the repeated check as a bug. |
| `apps/api/src/connections/ports.ts` | KEEP | Persistence aliases derive from database contracts; provider clients expose only the used methods. Encryption requires a context and signal. Lifecycle ownership remains on the runtime rather than individual use cases. |
| `apps/api/src/connections/telemetry.ts` | FIX WQ-064 | Counter/clock failure isolation is intentional, but trace fallback can execute the command twice or surface trace rejection as command failure. Small callback interface already permits precise tests. |
| `apps/api/src/connections/tokens.ts` | KEEP | One stable symbol matches the authorization provider and all three guards. |
| `apps/api/src/connections/types.ts` | KEEP | Reuses public request/response schemas, adds strict workspace params and the minimal request-abort adapter. No independent credential-schema copy. |
| `apps/api/src/connections/use-case-support.ts` | KEEP | Small shared command metadata, plaintext encoding, hashed test key and explicit secret-free response projections. Preserve versioned provider-key bytes. Hashing operates on parsed contract values; do not silently change persisted request-hash semantics during readability work. |
| `apps/api/src/connections/use-cases.ts` | KEEP | Create and rotate authorize, check replay before KMS, seal with immutable identity context, then persist and clear plaintext. Their different CAS/create fields justify explicit bodies. Do not introduce a generic command class to remove modest repetition. |
| `apps/api/src/platform/connections/connection-runtime.module.ts` | FIX WQ-065; WQ-057 integration | One composition owner supplies database, destination database, encryption and provider adapters. Close caching is useful; eager invocation inside allSettled skips later owners on synchronous throw. Construction lacks partial-acquisition cleanup. |
| `apps/api/test/connections/controllers.test.ts` | TEST WQ-066/WQ-067 | Valuable guard-context precedence, invalid actor and no-delegation assertions. `as never` collaborators return invalid partial responses, and test names claim body parsing/HTTPS enforcement that this controller intentionally delegates. |
| `apps/api/test/connections/credential-boundaries.test.ts` | KEEP; TEST WQ-067 | Compares wire/resolved credential representations, including normalization and delimiter bytes. Invalid cases are useful but need descriptive row labels and a valid adjacent aggregate-byte boundary. |
| `apps/api/test/connections/errors.test.ts` | TEST WQ-067 | Current safe-code assertions are useful, but absence of cause on the input error does not prove output redaction. Missing destination variants and unknown fallback deserve named rows and actual HTTP serialization assertions. |
| `apps/api/test/connections/failure-notification-destinations.test.ts` | TEST WQ-066/WQ-067 | Exact command hash and replay metadata comparisons are good. Seven independent operations in one case leave list/get results weakly checked; names say errors are mapped while direct controller calls only propagate database errors. |
| `apps/api/test/connections/http-stack.test.ts` | TEST/REFACTOR WQ-067 | Real Nest composition exercises auth, hidden cross-workspace destination access and create/test replay without returning credentials. One long story has no authenticated bad-CSRF request despite its title; the replay fake does not validate hashes. Keep genuine HTTP evidence and narrow what it claims. |
| `apps/api/test/connections/module.test.ts` | KEEP; TEST WQ-067 | Metadata assertions honestly inspect registration, not actual Nest resolution. Add the destination-absent case; root HTTP test supplies composed DI evidence. |
| `apps/api/test/connections/telemetry.test.ts` | TEST WQ-064 | Only normal trace success/work failure is covered. Count/duration/clock/trace failures and work-at-most-once behavior are absent. |
| `apps/api/test/connections/use-cases.test.ts` | TEST/REFACTOR WQ-067 | Good replay, cancellation-after-KMS, provider outcome, buffer wiping and dispatch-marker tests. Missing revocation at the explicit second check and combined mismatch/missing-client cases weaken branch discrimination. Split by command/testing behavior while sharing only typed fixtures. |

## WQ-064 — tracing must not repeat or replace connection commands

**P2 FIX/TEST; J01/J07/J08/J12.** `telemetry.ts:62–66` catches a synchronous
trace failure by running `measured()` again:

```ts
try {
  return options.trace(operation, measured);
} catch {
  return measured();
}
```

A trace adapter can start the callback and then throw; the fallback starts a
second command. A returned rejecting promise bypasses this catch, including
rejection after a successful command. Current-code callback probes produced:

| Trace behavior | Work calls | Caller result |
| --- | ---: | --- |
| Throws before callback | 1 | committed |
| Calls callback, then throws | 2 | committed |
| Rejects before callback | 0 | trace failed |
| Calls callback, then rejects | 1 | trace failed |

This proves the exported telemetry adapter's failure-isolation contract is
incomplete; it is not evidence that the ordinary OpenTelemetry SDK currently
throws or that a real external notification was duplicated. The source
explicitly promises diagnostics cannot change command truth, and its injected
trace interface makes these cases legitimate regression tests.

Create one per-measure invocation promise for the operation. Pass an at-most-once
callback to tracing and use that same promise for fallback and the authoritative
caller result. Observe trace rejection so it cannot become unhandled; retain
the original operation rejection exactly, even when it is `undefined` or a
non-Error. Do not retry the business operation after instrumentation failure or
let a post-work trace error replace its result. Keep the trace span around work
when tracing works normally. A wrapper that awaits trace then blindly calls
work in catch does not fix the issue. This needs no new public telemetry
framework.

Tests in `telemetry.test.ts`: all four rows; trace calls callback twice; work
rejects while trace also fails; exact work count 1, metrics once and identical
returned/thrown value. Add counter/duration throw, clock throw/nonfinite and
backward-time rows, asserting bounded labels and nonnegative duration. Keep
business failure separately identifiable from diagnostic failure. Run the
connection suite and API typecheck. Implement before reorganizing tests.

## WQ-065 — own construction failure and defer every resource close

**P2 FIX/TEST; J07/J08.** `connection-runtime.module.ts:104–108` evaluates
`database.close()` before constructing the allSettled input. If it throws
synchronously, destination/encryption cleanup never starts. A public runtime
probe with an injected throwing database closer and a real unconnected
destination pool observed no destination pool close; a rejected-promise
control reached pool close and returned AggregateError. The probe explicitly
closed the remaining destination owner afterward.

Use deferred thunks, as the adjacent artifact runtime already does:

```ts
const results = await Promise.allSettled([
  Promise.resolve().then(() => database.close()),
  Promise.resolve().then(() => destinationDatabase.close()),
  Promise.resolve().then(() => encryption?.close()),
]);
```

Keep the cached close promise and aggregate all failures in deterministic owner
order. This local fix complements, but does not replace, WQ-057's application
shutdown coordination: Nest must still reach this owner if another module's
hook fails.

Construction at lines 53–84 acquires databases before encryption, telemetry
and client composition without a catch. A later constructor failure has no
returned owner for earlier resources. Track acquired resources from the first
allocation and release them on failure. Because the factory is synchronous
while database close is asynchronous, make the ownership/error propagation
choice explicit in this private composition seam: either adopt an awaited
factory and update its app caller, or order fallible non-owning validation
before allocation and provide a provably safe failure cleanup path. Do not
fire-and-forget cleanup or pretend a synchronous catch awaited pool shutdown.
Preserve shared-database leases (their close is a no-op) and the existing
ownership of injected connection database; injected encryption is not acquired
as an encryption runtime and must not gain an invented close requirement.

Add `test/connections/runtime.test.ts` using the existing artifact runtime
test conventions and a minimal construction seam if needed. Cover each later
construction failure, synchronous/asynchronous close failure, multiple failures,
concurrent/repeated close and shared-runtime ownership. Assert all and only
acquired resources close once; constructor and cleanup errors both remain
observable. Do not replace actual shared-runtime compatibility evidence with a
factory spy alone. API build/typecheck, connection tests and bootstrap shutdown
regressions are acceptance gates. No new ADR is needed for restoring ownership.

## WQ-066 — separate destination transport and reuse context projection

**P2 REFACTOR/TEST; J02/J04/J05/J06/J08.** The destination file combines
route schemas, request helpers, seven typed use cases, response mapping and
seven decorated endpoints. Unlike ordinary connection routes, its
`requestCommand` at lines 67–87 reads request identifiers directly, then
independently chooses the guard actor. A guarded actor can therefore carry
different request/trace IDs from the metadata persisted by the destination
command. Ordinary connection routes deliberately give guard identifiers
precedence, and their tests state that contract.

Move destination controller/HTTP-only parsing into a feature-local controller
file; retain the typed use-case class with its database projection and request
hashing. No generic CRUD base class, per-method class explosion or additional
public layers. Both ordinary and destination controllers should project actor
and identifiers once with `projectAuthenticatedWorkspaceContext`, then append
route/command-specific fields. Remove the ordinary controller's pass-through
`guardAuthorization`, `actorFrom` and `requestMetadata` wrappers after replacing
their uses. Reuse `readHeader` for idempotency selection where its duplicate
semantics match the contract; preserve strict `parseIdempotencyKey` behavior
for destination commands rather than weakening it during consolidation.

Keep destination use-case inputs typed and the existing transactional database
authorization. Inspection of `failure-notification-destinations.ts` in the
database at lines 214–232 and its operation call sites confirms active actor,
membership/workspace and manage-versus-builder checks; this finding does not
claim that direct use-case calls bypass those checks. Do not add a second
authorization subsystem merely for symmetry with secret operations.

Replace response spread at destination line 117 with an explicit public field
projection (and the shared response schema if validation is desired). Today's
database record fields match the public response; this is future disclosure
prevention/locality, not a demonstrated current secret leak. Preserve IDs,
configuration, status, version and ISO timestamps exactly.

Regression acceptance: all seven routes retain method/status/guard/CSRF/rate
policy; guarded actor and identifiers agree in database commands; no-guard
session fallback remains identical; malformed session context maps through the
established request-invalid error; no extra persistence fields escape; hashes
and replay metadata remain byte-compatible. Existing barrels keep callers
working. Implement after WQ-064/WQ-065, with controller and HTTP tests.

## WQ-067 — make connection tests discriminate the actual guarantees

**P2 TEST/REFACTOR, small cleanup FIX; J02/J07/J08/J09/J12/J14.**

- `use-cases.test.ts`: add active→missing/inactive/downgraded membership and
  active→suspended workspace between `startConnectionTest` and secret access.
  Assert two lookups, safe not-found, no secret resolution/open/dispatch or
  completion, and one abandonment. Existing tests count a successful recheck
  but never deny at that recheck.
- The last email/slack mismatch rows combine wrong credential with missing
  provider client. Separate each invalid condition against an otherwise valid
  baseline. Assert no provider was called and plaintext is cleared. Include
  invalid UTF-8, malformed JSON and valid JSON with invalid credential fields.
- HTTP/Slack/email outcome rows should assert exact persisted
  `reauthorizationRequired`, HTTP status and error code, not only the returned
  error string. Include all credential-rejection Slack codes, adjacent success
  statuses and non-rejection provider failures. Use descriptive row names.
- The marker-error test currently makes the entire HTTP fake reject. Retain it,
  and add a fake that actually awaits `beforeDispatch` when that persistence
  callback fails; assert no simulated network action after the marker failure.
- `connection-testing.ts:156–160`: abandonment intentionally must not mask the
  original failure, but chained `.catch()` does not catch a synchronous throw
  from the injected abandonment method. Use a small awaited try/catch or a
  deferred invocation. Test rejecting and synchronous abandonment with exact
  original rejection identity and plaintext clearing. Do not retry provider
  dispatch as part of this cleanup.
- Split create/rotate/revoke tests from connection-test scenarios. Retain one
  shared typed fixture for records, persistence and encryption; do not duplicate
  the 150-line setup into each new file. Keep coherent successful stories
  intact, split unrelated outcomes now hidden in the same `it`.
- `controllers.test.ts`: replace broad `as never`/invalid partial results with
  typed test adapters and schema-valid response fixtures. Assert the signal,
  identity and exact delegation for rotation as well as create/test. Rename
  “parses create input” and “bounded HTTPS connection test”: the controller
  forwards unknown bodies, including HTTP, and the use case validates them.
- `failure-notification-destinations.test.ts`: named operation rows should
  verify exact list/get/status results as well as metadata. “Maps conflicts”
  and “maps hidden reads” currently assert raw database errors; rename those
  propagation tests and prove actual public mapping in the HTTP suite. Keep
  exact replay hash comparisons but do not call two fake method invocations
  durable idempotency proof.
- `http-stack.test.ts`: separate auth/CSRF denial, connection replay/secret
  omission and destination authorization into named cases sharing a fixture.
  Add authenticated requests with absent/mismatched CSRF and assert no
  persistence/encryption. Cover builder versus owner/admin destination
  management and viewer denial. Make replay fakes compare identity/key/hash or
  explicitly limit them to same-input replay; real conflict proof belongs in
  database integration tests. Use deterministic fixture expiry where practical.
- `errors.test.ts`: named rows for secret-version conflict, all destination
  errors, authorization, invalid context/key, Zod and unknown failure. Check
  exact public code/detail in the mapper and serialized HTTP omission of raw
  credentials/provider causes in the HTTP suite. `expect(failure).not.toHaveProperty
  ('cause')` checks the input object, not what a response exposes.
- `module.test.ts`: destination persistence absent means both destination
  controller and provider absent; ordinary routes/providers remain. No need to
  duplicate the real Nest composition already exercised by the HTTP suite.
- `credential-boundaries.test.ts`: label invalid rows by credential/constraint
  and add a valid aggregate-size neighbor to the delimiter-overflow case.
  Preserve the existing normalization-equivalence comparison.

Acceptance: each claimed guarantee has an independently failing assertion;
66 existing tests remain behaviorally represented, new regressions pass, and
API build/typecheck succeeds. Do not claim real KMS/provider/database replay
qualification from these injected tests. Deliver regressions alongside their
specific fixes, then reorganize tests without changing contracts.
