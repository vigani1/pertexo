# API identity and workspace review

Date: 2026-09-12. Scope: 55 frozen inventory files, all source and tests read
in full by the primary reviewer. Targeted Vitest execution passed 18 unit test
files / 187 tests. The real-service integration file was read, not executed.
Public-interface probes used current compiled code and injected collaborators;
no real provider, Redis or PostgreSQL request ran.

## Individual file judgments

| File | Disposition | Specific judgment |
| --- | --- | --- |
| `apps/api/src/identity/crypto.ts` | KEEP | Bounded token generation, SHA-256 digest and constant-time equality have separate purposes. Length validation before comparison is intentional; no home-grown replacement cryptography. |
| `apps/api/src/identity/csrf.ts` | KEEP | Double-submit comparison requires both tokens and validates bounds before comparison. Session authentication and cookie attributes are separate controls, not substitutes for CSRF. |
| `apps/api/src/identity/errors.ts` | KEEP | Stable typed identity vocabulary preserves provider versus user/session failures. Unknown-object containment belongs to the existing global WQ-055 work, not a new mapper framework. |
| `apps/api/src/identity/index.ts` | KEEP | Exposes identity services and typed ports without database implementation. Adjust callback schema exports together under WQ-069. |
| `apps/api/src/identity/oidc.ts` | REFACTOR WQ-070; WQ-069 | Ordered transaction consumption, provider exchange, issuer/audience/nonce checks and internal mapping are justified phases. Five consume statuses plus an optional success value make impossible states representable; preserve atomic consume-before-exchange and explicit defensive checks. Callback parsing correctly strips unknown provider parameters. |
| `apps/api/src/identity/ports.ts` | REFACTOR WQ-070 | Actual provider, persistence, cookie and clock seams support tests and production adapters. Tighten only transaction consumption's result variants; do not replace narrow interfaces with one service locator. |
| `apps/api/src/identity/session.ts` | KEEP; TEST WQ-073 | Stores digests, enforces expiry/revocation, clones returned expiry and revokes a newly created session after cookie failure. Issuance, authentication and rotation differ materially; retain explicit methods and strengthen failure evidence. |
| `apps/api/src/identity/types.ts` | KEEP | Separates external identity, internal identity, transaction secrets, session records and safe client metadata. Provider roles do not become workspace authority. |
| `apps/api/src/identity-infrastructure/index.ts` | KEEP | Small intended adapter exports; no runtime work in barrel. |
| `apps/api/src/identity-infrastructure/oidc-adapter.ts` | REFACTOR WQ-070; TEST WQ-073 | Real JOSE signature/issuer/audience/time verification and bounded response reading are valuable. Endpoint protocol validation is duplicated with a naming heuristic. Keep token and JWKS transport ownership distinct, including cancellation; do not infer deployed provider conformance from mocks. |
| `apps/api/src/identity-infrastructure/oidc-request-validation.ts` | REFACTOR WQ-070 | Input bounds, client/redirect match and URL size checks are legitimate defense. Challenge length is described by two inconsistent-looking ranges even though the tighter regex wins; express the actual accepted set once. |
| `apps/api/src/identity-infrastructure/oidc-response-cleanup.ts` | KEEP; TEST WQ-073 | Bounded cancellation avoids letting a noncooperative body trap the caller. A 250 ms bound limits waiting, not a claim underlying work stopped. Preserve losing-promise observation. |
| `apps/api/src/identity-infrastructure/oidc-secret-encryption.ts` | REFACTOR/FIX WQ-071 | Versioned AES-GCM with authenticated context and canonical wire checks is coherent. Configuration normalization repeatedly transforms entries, uses a nested ternary and allocates key buffers before duplicate rejection; temporary plaintext buffers lack explicit ownership. |
| `apps/api/src/platform/identity/identity-runtime.module.ts` | FIX WQ-065 | Runtime correctly composes one identity database and transaction store. Eager close calls in allSettled and missing partial-construction cleanup repeat the connection-runtime ownership defect. Do not invent a close method for the encryption adapter. |
| `apps/api/src/workspaces/actor-context.ts` | KEEP | Runtime brand, UUID validation, bounded identifiers and frozen projection prevent arbitrary request objects from being treated as established actor context. UUID helper accepts syntactically valid upper case; naming alone does not prove a reachable identity bug. |
| `apps/api/src/workspaces/audit.ts` | CONDITIONAL WQ-072 | Unused production facade builds sanitized audit facts but is not the durable audit owner. Recursive depth/key limits are useful but not a total byte/node budget, and eager Object.entries can execute filtered getters. Check necessity before improving an unused parallel abstraction. |
| `apps/api/src/workspaces/authorize-workspace.ts` | FIX WQ-068 | Fresh authorization validates actor, route, access identity, membership, status and capability in a readable fail-closed sequence. Cached proof omits the allowed-status requirement and abort check; issued brand alone is insufficient for those inputs. |
| `apps/api/src/workspaces/index.ts` | KEEP; WQ-072 | Groups the authorization interface. If the unused audit facade is retired, remove only its exports after checking consumers. |
| `apps/api/src/workspaces/policy.ts` | KEEP | Re-export of the canonical shared policy prevents a second capability matrix. One line is appropriate. |
| `apps/api/src/workspaces/types.ts` | KEEP; WQ-068 | Reuses shared role/status/capability definitions and exposes immutable request context. Keep additional authorization proof private where possible rather than forcing every controller to understand it. |
| `apps/api/src/identity-workspace/authenticated-command-context-error.ts` | KEEP | Stable narrow error type lets the global filter recognize context projection failures without importing controllers. |
| `apps/api/src/identity-workspace/authenticated-command-context.ts` | KEEP | Single projection preserves guard-established actor, authorization and request/trace precedence. It earns its interface by concentrating a security invariant used by multiple features. |
| `apps/api/src/identity-workspace/contracts.ts` | KEEP; WQ-069 | Re-exports shared contracts instead of copying request shapes; callback wire schema reconciliation must keep this facade consistent. |
| `apps/api/src/identity-workspace/controllers.ts` | REFACTOR/TEST WQ-073 | Explicit guard order, rate-limit policy and response schemas are readable. OIDC/session cookie serialization and unrelated workspace routes share 432 lines; split by HTTP responsibility without extracting one-line wrappers. Binding-cookie clearing preserves the original callback failure. |
| `apps/api/src/identity-workspace/cursor.ts` | KEEP | Canonical base64url, strict tuple shape and timestamp validation protect stable member pagination. Preserve exact precision and invalid/year-zero behavior; no opaque generic cursor framework. |
| `apps/api/src/identity-workspace/database-adapter.ts` | KEEP; TEST WQ-073 | Explicit null-to-undefined and record projections separate storage and application contracts. Database owns revocation time despite the application port accepting a timestamp; do not silently change persisted clock semantics. Tests currently cover only a small subset of mapping. |
| `apps/api/src/identity-workspace/errors.ts` | KEEP; TEST WQ-073 | Ordered known mappings retain stable response vocabulary and conservative unknown fallback. Verify serialized output rather than assuming direct controller exceptions are already HTTP-mapped. |
| `apps/api/src/identity-workspace/guards.ts` | KEEP; TEST WQ-068 | Authenticates once, freezes session/context and explicitly chooses capability/status/disclosure per guard. Different lifecycle status sets are intentional; preserve broad lifecycle visibility and active-only mutation. |
| `apps/api/src/identity-workspace/index.ts` | KEEP | Composition exports are explicit; maintain compatibility when moving controllers, not a wholesale barrel redesign. |
| `apps/api/src/identity-workspace/module.ts` | KEEP; TEST WQ-073 | Explicit tokens and factory dependencies support one shared identity graph; registration contains meaningful ownership, not redundant wrappers. Existing actual Nest resolution tests matter more than decorator-array snapshots. |
| `apps/api/src/identity-workspace/ports.ts` | KEEP; review metadata contract with database ledger | Narrow use-case persistence and authorization readers avoid storage imports in behavior. Lifecycle input accepts correlation/metadata fields not forwarded by the current use case; verify authoritative command/audit semantics before proposing a change. |
| `apps/api/src/identity-workspace/request-identifiers.ts` | KEEP | Bounded safe request and trace identifiers are suitable audit correlation. This is not a complete W3C trace-context parser; neither comments nor tests should claim it is. Middleware establishes stable real-request identifiers. |
| `apps/api/src/identity-workspace/telemetry.ts` | FIX WQ-064 | Same trace callback/fallback problem as connection telemetry. Local probe confirms work is called twice if tracing starts it and then throws. Keep safe operation labels and isolate metrics failures. |
| `apps/api/src/identity-workspace/tokens.ts` | KEEP | Stable symbols express runtime injection identities for interfaces. No dynamically constructed token lookup. |
| `apps/api/src/identity-workspace/types.ts` | KEEP | HTTP request additions and contract aliases remain small. Transport cookie interface permits sync/async writers intentionally. |
| `apps/api/src/identity-workspace/use-cases.ts` | KEEP structure; WQ-064/WQ-069/WQ-073 | Profile, members, creation and lifecycle operations have separate typed responsibilities despite sharing a file. Response parsing, pagination and lifecycle-visible states are deliberate. Avoid a generic CRUD pipeline that hides authorization or changes lifecycle semantics. |
| `apps/api/test/identity/oidc.test.ts` | TEST WQ-070/WQ-073 | Useful nonce, binding, one-use transaction and identity mapping scenarios. One replay setup accidentally causes the fake provider's verifier assertion to fail, so the first attempt's intended failure is not honestly controlled. Split independent missing-profile fields. |
| `apps/api/test/identity/session.test.ts` | TEST WQ-073 | Digest, cookie attributes, expiry and cleanup assertions are valuable. Split revoked/expired/rotation stories and explicitly cover cookie failure followed by revoke failure, preserving the cookie error. |
| `apps/api/test/identity-infrastructure/identity-runtime.test.ts` | TEST WQ-065 | Rejected-promise close coverage does not prove synchronous-throw containment or partial acquisition. Assert every owned closer is attempted exactly once. |
| `apps/api/test/identity-infrastructure/oidc-adapter.test.ts` | TEST/REFACTOR WQ-073 | Signed-token verification uses real JOSE and should remain. Repeated RSA generation in unrelated network cases, combined invalid fields, misleading nonce case naming and local-server cleanup/timer gaps reduce precision. |
| `apps/api/test/identity-infrastructure/oidc-secret-encryption.test.ts` | KEEP; TEST WQ-071 | Rotation/context/tamper and malformed configuration checks protect wire compatibility. Single-object previous-key compatibility is explicitly tested despite the public array type; preserve or make a separately approved compatibility decision. |
| `apps/api/test/workspaces/artifact-policy.test.ts` | KEEP | Small exact capability assertions protect the artifact policy's intended roles; size is not a reason to merge unrelated authorization suites. |
| `apps/api/test/workspaces/audit.test.ts` | CONDITIONAL WQ-072 | Tests demonstrate redaction intent but are the only consumer of the facade. If retained, add getter/total-budget evidence; if retired, move necessary guarantees to actual audit writers rather than deleting audit obligations. |
| `apps/api/test/workspaces/authorization.test.ts` | KEEP; TEST WQ-068 | Good positive/negative role, status, identity and forged-context coverage. Add legitimate proof issued under a broader status policy and reused under a narrower policy, plus already-aborted reuse. |
| `apps/api/test/identity-workspace/contracts.test.ts` | KEEP; WQ-069 | Public schema assertions are useful only when callback semantics match the runtime. Keep bounded profile/workspace examples and regenerate affected contract fixtures. |
| `apps/api/test/identity-workspace/controllers.test.ts` | TEST/REFACTOR WQ-073 | Cookie attributes/clearing and context forwarding are valuable. A malformed-workspace-body case omits the idempotency key and fails before the purported body check. Invalid partial success fixtures and names claiming global mapping must be corrected. |
| `apps/api/test/identity-workspace/database-adapter.test.ts` | TEST WQ-073 | 49 lines exercise only selected forwarding. Add valid/null optional-field mappings and signal forwarding through the public adapter, without reproducing SQL tests here. |
| `apps/api/test/identity-workspace/errors.test.ts` | KEEP; TEST WQ-073 | Current known-code mapping assertions are sound but generic identity conflict/session/Zod/unknown cases and serialized secret absence need independent rows. |
| `apps/api/test/identity-workspace/guard-resolution.test.ts` | KEEP | Resolves actual guards through three composed Nest modules, supplying genuine DI evidence. If expanding cases, make mutable authentication state fixture-owned rather than sharing module globals. |
| `apps/api/test/identity-workspace/guards-request-context.test.ts` | KEEP; WQ-068 | Verifies stable frozen session/context and identifiers across guards; preserve proof reuse's no-second-lookup behavior while adding status-policy compatibility. |
| `apps/api/test/identity-workspace/nest-module.test.ts` | KEEP | Registration checks cover supplied ports and optional session policy. Distinguish metadata inspection from the actual resolution suite's stronger evidence. |
| `apps/api/test/identity-workspace/real-api.integration.test.ts` | TEST/FIX WQ-074 | Valuable real API/database/RLS, replay and lifecycle assertions. Resources are created at test collection, setup failure can make teardown dereference an absent app, stories depend on an earlier test's workspace, and SSE waits lack unconditional release. Not executed during this audit. |
| `apps/api/test/identity-workspace/request-identifiers.test.ts` | KEEP | Tests bounded correlation behavior without asserting full distributed tracing conformance. Keep deterministic supplied identifiers; random fallback is a separate behavior. |
| `apps/api/test/identity-workspace/telemetry.test.ts` | TEST WQ-064 | Existing ordinary success/failure labels do not exercise trace callback duplication or instrumentation rejection. Add exact work-count and result identity assertions. |
| `apps/api/test/identity-workspace/use-cases.test.ts` | KEEP; TEST WQ-069/WQ-073 | Exact metadata, stable replay and lifecycle response assertions protect real contracts. Add unavailable/suspended current user and exact next-cursor checks; callback unknown-parameter acceptance must be intentional and shared. |

## WQ-068 — authorization proof must satisfy the requested lifecycle policy

**P2 FIX/TEST; J01/J03/J09/J12.** In
`apps/api/src/workspaces/authorize-workspace.ts:73`, a WeakSet records only
that the context was issued. `assertAuthorizedWorkspaceContext:187–210`
compares actor/request/route/capability but has no status evidence.
`authorizeWorkspaceOperation:213–226` ignores `allowedWorkspaceStatuses` and
`signal` on the cached branch.

The public-interface reproduction uses a legitimate viewer context issued for
`workflow:read` on a suspended workspace with `allowedWorkspaceStatuses:
['suspended']`. A fresh active-only request rejects with `auth.forbidden`;
reusing that context for the otherwise identical active-only request succeeds.
This is an exported-interface policy inconsistency, **not a demonstrated HTTP
bypass**: currently inspected guards and use cases use matching status sets.

Record observed workspace status in private issued-context evidence, for
example a WeakMap, and compare it with the requested allowed statuses before
accepting reuse. Check abort before returning cached proof. Preserve actor,
request, trace and capability equality, frozen records, no additional database
lookup for matching request-local proof, and fresh authorization for secret
egress. Do not turn this into a cross-request cache or remove the broader
active/suspended/pending-deletion visibility of lifecycle reads.

Proposed shape, not a new public framework:

```ts
const proof = issuedContexts.get(context);
if (proof === undefined) throw invalidContext();
assertSameRequestAndCapability(context, input);
input.signal?.throwIfAborted();
if (!allowedStatuses.includes(proof.workspaceStatus)) {
  throw lifecycleDenied(input.disclosure);
}
return context;
```

Tests: broader-to-narrower reuse rejects; same status policy reuses without a
lookup; active proof accepted under broader policy; abort preserves its reason;
forged/cross-actor/cross-request/cross-capability contexts still reject. Keep
the guard-resolution suite. Acceptance: both fresh and reused authorization
agree for identical observed state and requested policy. Implement before
controller/test reorganizations; verify API typecheck and authorization suites.

## WQ-069 — reconcile callback wire schema without violating OAuth

**P2 FIX/TEST; J01/J06/J13/J14.** The published callback object in
`packages/contracts/src/http/identity-workspace.ts` is strict, whereas
`apps/api/src/identity/oidc.ts` uses a stripping object and
`identity-workspace/use-cases.ts:216` parses that object. A local public
application probe with valid code/state and an extra field is rejected by the
published schema but accepted by the application, which invokes login and
issues a session.

Do **not** fix this by making the runtime strict. OAuth authorization-code
responses require clients to ignore unrecognized response parameters.
[RFC 6749 §4.1.2](https://www.rfc-editor.org/rfc/rfc6749#section-4.1.2).
Keep a provider-facing tolerant wire parser that projects validated code/state;
align the shared published contract and generated description with it. If an
internal normalized command needs strictness, give that different role an
explicit name instead of presenting it as the wire query. Preserve duplicate
known-parameter rejection, state/browser binding, bounds and error mapping.
This does not authorize accepting malformed code/state or bypassing registered
extension validation.

Tests: extra unknown parameter accepted and not forwarded; repeated code/state,
missing fields, invalid lengths and malformed types rejected before login;
shared schema and HTTP/application behavior agree. Run contract generation
checks, contract tests, API callback tests and typecheck. Coordinate with WQ-051
contract ownership; no duplicate schema copy or protocol-policy ADR is needed
merely to correct this mismatch.

## WQ-070 — simplify OIDC validation and transaction outcomes

**P2 REFACTOR/TEST; J02/J03/J05/J06.** Three bounded changes:

1. `oidc-adapter.ts:61–78` guesses endpoint fields using `endsWith('Endpoint')`
   and separately names issuer/JWKS; later explicit protocol validation checks
   the endpoints including redirect URI again. Keep one explicit typed endpoint
   list and one validation owner for protocol, credential and fragment policy.
   Do not silently change test-only HTTP allowances or redirect policy.
2. `oidc-request-validation.ts` bounds challenge length at 32–512, then its
   regex permits only 43–128. Use one named predicate expressing the current
   43–128 accepted set. Generated S256 challenges are 43 characters, but the
   broader existing compatibility must not be narrowed as a readability edit.
3. `identity/ports.ts:26–29` permits `{status: 'ok'}` and a transaction on a
   failure. Use a discriminated union with required transaction only for `ok`.
   Map database results at the adapter and make consumption handling exhaustive.
   Preserve existing missing/expired/replayed/binding-mismatch distinction,
   undefined compatibility where actually required, atomic consume ordering,
   and defensive checks at untrusted seams.

```ts
type ConsumeResult =
  | Readonly<{ status: 'ok'; transaction: OidcLoginTransaction }>
  | Readonly<{ status: 'missing' | 'expired' | 'replayed' | 'binding_mismatch' }>;
```

Acceptance: each endpoint invalid in isolation, unchanged valid redirect and
test HTTP cases, challenge boundary matrix, every consume outcome and no
provider exchange after denial. Compile all adapters against the union. Do not
merge signature verification with application-owned nonce/internal identity
mapping, or add a generic authentication state-machine framework.

## WQ-071 — explicit encryption parsing and temporary-buffer ownership

**P2 REFACTOR/FIX/TEST; J02/J07/J09/J11.** In
`oidc-secret-encryption.ts:62–99`, normalization uses a nested ternary followed
by filter/map/set/map and decodes keys before detecting duplicate versions.
`assertTextBounded:102–112` chooses a byte limit from a label string. `seal`
creates an untracked plaintext Buffer; `open:204–212` concatenates partial
decryption output and converts it to a string without clearing owned buffers.

Normalize previous keys explicitly, preserving the tested single-object input
compatibility. Validate entry shape/version and uniqueness before decoding;
on later parse failure, wipe already allocated key buffers. Pass the byte limit
as a parameter rather than using a prose label as executable policy. Pre-bound
encoded input before decode, retain canonical encoding and exact nonce/tag
sizes. Keep key version and associated-data wire bytes unchanged.

Track temporary plaintext inputs and decryption chunks with try/finally,
including partial `decipher.update` output if tag verification fails. Clear
those buffers after creating the required returned string. This is best-effort
buffer lifetime reduction, not a promise to erase immutable strings, crypto
internals or process memory. Retain long-lived active/previous keys for the
adapter's existing lifetime; do not invent a new provider or close contract.
The persistence wire schema already bounds stored values, so this review does
not claim a demonstrated remote allocation attack.

Tests through the existing adapter: round trip, previous-key rotation, wrong
context/tag, malformed canonical bytes, exact and over-limit UTF-8 inputs,
duplicate versions and partially invalid multi-key config. If buffer wiping
uses a private test seam, observe only owned buffers without changing global
Buffer/crypto behavior. Acceptance: unchanged sealed format/error vocabulary,
all owned plaintext temporaries cleared on success and failure, no accidental
change to previous-key compatibility. Coordinate shared principles with WQ-033,
but do not force unrelated encryption implementations into one abstraction.

## WQ-072 — decide whether the unused API audit facade earns its existence

**P3 CONDITIONAL; J05/J08/J09/J11.** A production-consumer search for
`buildAuditFact` finds its definition/export and tests, not a runtime caller.
`workspaces/audit.ts` is therefore not evidence that durable audits currently
leak data or that remote callers can exhaust this sanitizer. Actual database
audit writers remain authoritative and must be inspected before retirement.

Gate: if there is no required current caller/contract, remove this unused
facade and its sole tests/exports, while keeping ADR-004's actual auditing
requirements covered at the durable writer. If a real required caller exists,
document it and keep the facade with explicit total entry/byte limits and
descriptor-safe traversal that does not eagerly evaluate filtered getters.
Depth four with up to 64 array elements per level is not a total work bound;
Object.entries reads values before key filtering. The `undefined` sentinel in
the safe-value union also has no producing branch and needlessly complicates
flattening and reads.

For retained code, add one independent test per sensitive key, getter not
invoked, aggregate array/object/string budget and depth boundary. Preserve the
chosen filter-versus-reject behavior; do not silently change audit output.
Acceptance is either a justified single owner with complete tests or removal
of genuinely unused parallel code—not an aesthetic rewrite of historical SQL.

## WQ-073 — make identity unit tests precise and readable

**P2 TEST/REFACTOR; J04/J05/J07/J12.** Concrete changes, after behavior fixes:

- `test/identity/oidc.test.ts`: the replay setup's fake exchange asserts a
  verifier never initialized by a valid first flow; an accidental AssertionError
  becomes provider-unavailable. Perform a valid first login then replay, or
  intentionally inject the documented provider failure. Assert the first
  outcome and exact exchange count. Split missing email from missing name.
- `test/identity/session.test.ts`: separate revocation, expiry and rotation
  stories. Add cookie-write failure plus revoke failure and assert the original
  failure is preserved. A missing row should be named missing rather than
  claimed to prove a stored revoked record. Keep actual expiry cloning checks.
- `test/identity-infrastructure/oidc-adapter.test.ts`: share one immutable
  generated keypair for network-only cases; keep real signed tokens for claim
  verification. Use labeled tables for lifetime and endpoint invalidity, one
  bad field per row. The bad-nonce row intentionally returns the nonce to the
  application; name it accordingly instead of claiming adapter rejection.
  Put server ownership inside try/finally immediately after acquisition,
  before listening/address/adapter construction can fail. Clear losing timers.
  Replace cancellation sleeps with controlled reader/deferred barriers and
  bounded cleanup assertions. Inspect reader lock release and abort-listener
  teardown on each outcome; do not call a timeout proof of transport cessation.
- `test/identity-workspace/controllers.test.ts`: give the malformed-body test
  a valid idempotency key and invoke the actual use case if claiming body
  validation. Otherwise rename it forwarding and move validation evidence to
  the use-case suite. Replace invalid `as never` success fixtures with complete
  typed responses. Direct calls propagate identity errors; global HTTP mapping
  belongs in a real HTTP assertion. Split cookie transport tests from workspace
  route tests, moving cohesive production cookie/controller code accordingly.
- `test/identity-workspace/database-adapter.test.ts`: named public-method
  cases for identity mapping, profile null/present, session null/present and
  optional metadata/date fields, access signal, create and revoke forwarding.
  Do not require a database just to prove structural projection.
- `test/identity-workspace/use-cases.test.ts`: unavailable/inactive user,
  exact encoded next cursor and no cursor, malformed cursor, callback extension
  handling, and complete lifecycle response assertions. Keep exact request and
  trace metadata tests. Check lifecycle metadata forwarding against the database
  command contract before adding expectations that would change semantics.
- `test/identity-workspace/errors.test.ts`: separate generic identity/session,
  conflict, Zod and unknown rows; check no secret/cause is serialized in the
  actual response. Do not assert redaction on the input exception itself.
- Keep actual Nest guard resolution and immutable guard-request-context tests.
  Use fixture-owned mutable state if extending them, not parallel mutation of
  module-level authentication globals.

Acceptance: every test name describes its exercised seam; each negative case
fails for its named cause; isolated tests run independently; no arbitrary
sleep or leaked local listener/server is needed. Existing signed-token,
browser binding, replay, cookie and internal-role protections remain covered.
Run the 18-file identity/workspace unit selection and API typecheck after each
coherent production/test change. A smaller test file is not acceptance by itself.

## WQ-074 — own the real-API fixture and isolate its stories

**P2 FIX/TEST; J07/J12.** In
`test/identity-workspace/real-api.integration.test.ts`, the describe callback
allocates identity database/transaction owners even when `describe.runIf`
skips tests. Setup creates persisted state before API initialization; teardown
unconditionally calls `application.close()` even if setup failed before assigning
it. That failure can prevent later resource cleanup. A workspace assigned in
an earlier test is needed by later member/deletion stories. The large workflow
author/publish/start/cancel/SSE case further mixes distinct contracts.

Move acquisition into an awaited fixture, track each owned resource from first
creation, and wrap partial initialization in cleanup. Close the application
before fixture-owned dependencies it uses; attempt remaining independent
closers through deferred thunks and report aggregate failures without hiding
the setup failure. Do not close injected aliases twice. Skipped collection must
acquire nothing. Preserve narrow workspace-scoped cleanup and disposable-service
gates; never run broad destructive SQL from a unit audit.

Seed each independent story through a fixture/helper, not an earlier `it`.
Split workflow HTTP behavior into named stories using the same authentication
fixture only where ownership is clear. Retain real RLS denial, ETag/replay,
outbox counts and assertions that requesting asynchronous deletion does not
immediately mutate active state. The fake OIDC provider's latest-request slot
requires sequential use or transaction-keyed state; do not parallelize it
blindly.

Bound each SSE `iterator.next()` and put abort/iterator return in finally.
The test's static `reauthorizeSession` callback is not proof of real HTTP SSE
session refresh; retain it as application-stream evidence and use a separately
qualified HTTP test for that stronger claim. Use adequate session TTL for the
long workflow story: a frozen application clock plus real database clock and
a five-second TTL creates competing clocks. Isolate expiry with deliberate
database state plus controlled application time.

Acceptance: forced failure at each acquisition stage releases prior owners;
skipped collection opens none; each story runs by name alone; cleanup attempts
all owners and preserves original errors; no unbounded stream wait; documented
service gates reflect actual dependencies. Execute only in the existing
configured disposable integration environment. This audit has not established
service-backed success. Coordinate fixture ownership with WQ-057/WQ-062.

## Shared findings and order

Extend WQ-064 to `identity-workspace/telemetry.ts:106–142` and its test file:
same measured-work promise must be authoritative and at-most-once. The local
callback-then-throw probe returns success after **two** work invocations today.
Extend WQ-065 to `platform/identity/identity-runtime.module.ts:119–123` and
`test/identity-infrastructure/identity-runtime.test.ts`: defer both transaction
and database closers, cache close result, and clean up partial acquisition.
Existing rejected-promise tests do not cover the eager synchronous throw.

Implement WQ-064/WQ-065 and WQ-068 first; reconcile WQ-069 with contract
generation next. Keep WQ-070 and WQ-071 as independently reviewable focused
changes. WQ-072 waits for the durable audit owner review. Apply WQ-073 with each
affected behavior, then WQ-074 in the existing disposable-service lane. No
architectural provider/session/authorization replacement is proposed.
