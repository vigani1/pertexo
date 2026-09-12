# Integrations — file-by-file quality review

Reviewed against the frozen inventory and current dirty source on 2026-09-12.
All 52 package files were read, including the complete 5,478 lines of tests and
support. `pnpm --filter @pertexo/integrations test`: **13 files, 293 tests passed**.
Additional current-source probes used local injected dependencies and synthetic
bytes; no real provider, KMS operation, credential or external side effect was
used. These are review findings, not implemented changes.

## Individual dispositions

Paths below are relative to `packages/integrations/`. Criteria are J01–J14 in
the parent plan. A finding reference is the implementation owner, not an
instruction to rewrite every related file.

| File | Disposition and concrete judgment |
| --- | --- |
| `packages/integrations/src/credentials/aws-envelope-runtime.ts` | KEEP factory ownership; TEST under WQ-033 for UTF-8 key-reference admission before allocation. The public config is parsed before normal client construction and `close` owns that client. |
| `packages/integrations/src/credentials/envelope-encryption.ts` | KEEP purpose/identity wrapper and opaque failure contract; WQ-033 tests the shared cipher through this boundary. Connection plaintext remains caller-owned, unlike webhook plaintext. |
| `packages/integrations/src/credentials/kms-client.ts` | KEEP explicit connection/request/socket budgets and two-attempt policy. Do not describe this as a strict whole-operation wall-clock deadline including credential discovery and retry backoff. |
| `packages/integrations/src/crypto/envelope-cipher.ts` | FIX/TEST WQ-033. Crypto mechanics belong together; buffer ownership and decode admission need improvement, not another generic crypto framework. |
| `packages/integrations/src/email/client.ts` | FIX WQ-028. Fixed endpoint, bounded response, request/response clearing and idempotency header are coherent; malformed refusal bodies currently erase status truth. |
| `packages/integrations/src/email/definition.ts` | KEEP exact immutable ABI-2 identity, provider policy and browser-safe schema registration. Separate definition/executor identities are published contracts, not redundant locals. |
| `packages/integrations/src/email/executor.ts` | FIX/TEST WQ-029, hardening WQ-030; local cleanup in WQ-035. Keep email-specific replay and cancellation semantics distinct from unsafe providers. |
| `packages/integrations/src/email/index.ts` | KEEP explicit browser export surface; no runtime credential resolution or KMS import. |
| `packages/integrations/src/email/validation.ts` | KEEP conservative ASCII mailbox grammar, normalized domain and strict credential/input contracts. The exclusions intentionally reject valid-but-unsupported mailbox variants. Byte ceilings partly overlap character ceilings; do not remove documented limits casually. |
| `packages/integrations/src/http-request/definition.ts` | KEEP conservative unsafe policy even for configured GET; the pinned operation policy is not dynamically inferred from method spelling. |
| `packages/integrations/src/http-request/executor.ts` | KEEP dispatch/artifact ownership stages, hardening WQ-030 and tests WQ-034. `BodyFailure` deliberately distinguishes throwing `undefined` from no failure; keep it. `cleanupStarted` prevents duplicate iterator cleanup; do not replace it with an unqualified `finally return()`. |
| `packages/integrations/src/http-request/index.ts` | KEEP explicit manifest/schema/type exports with executor restricted to the server entry. |
| `packages/integrations/src/http-request/validation.ts` | FIX WQ-036. Header case-folding, collisions, transport-owned exclusions and aggregate byte checks are justified. The URL refinement must not throw on ordinary malformed input. |
| `packages/integrations/src/http/address-policy.ts` | KEEP explicit IPv4/IPv6 parsing and prefix matching. `isIP` admission precedes internal parsing, IPv6 is conservatively restricted to global-unicast space, scoped and transition addresses remain blocked. No speculative lookup cache. |
| `packages/integrations/src/http/header-value.ts` | KEEP small shared serializer-domain predicate; browser-safe and verified against Node control-byte rejection. |
| `packages/integrations/src/http/iana-address-policy-snapshot.ts` | KEEP human-reviewed policy data and upstream hashes. Inspect the drift-check producer separately in infrastructure; do not silently regenerate allow/deny policy from a live registry. |
| `packages/integrations/src/http/node-transport.ts` | KEEP pinned lookup, original hostname/TLS semantics, disabled pooling and native stream ownership. WQ-032 requires distinguishing native cancellation disposal from the injectable transport contract. |
| `packages/integrations/src/http/outcome-policy.ts` | KEEP ordered side-effect policy decisions and exhaustive stable error vocabulary; WQ-034 strengthens the broad matrix oracle. The different definite/ambiguous paths are meaningful, not excess conditions. |
| `packages/integrations/src/http/retry-after.ts` | KEEP bounded integer-seconds policy; HTTP dates deliberately use the minimum. Current callers provide valid fixed maxima, so do not add a general configurable retry framework. |
| `packages/integrations/src/http/secure-http-error.ts` | FIX/harden WQ-030. Deliberately discard raw causes at the public network boundary; preserve safe categories, not arbitrary upstream details. |
| `packages/integrations/src/http/secure-http-request.ts` | KEEP explicit admission, normalized headers and copied request body; hardening WQ-030. The raw HTTP client and workflow-node validation have different trust/policy responsibilities; do not merge their blocked-header sets indiscriminately. |
| `packages/integrations/src/http/secure-http.ts` | FIX WQ-030/WQ-031, TEST/CONDITIONAL WQ-032. Redirect policy, public-address admission, dispatch evidence and body consumption are real phases. Awaiting the durable marker despite cancellation is intentional and tested. |
| `packages/integrations/src/http/stream-redaction.ts` | KEEP bounded raw/emitted bytes, longest-pattern precedence, cross-chunk carry, event-loop yielding and chunk clearing; hardening WQ-030. A faster matcher is not justified without a representative benchmark preserving overlap and cancellation behavior. |
| `packages/integrations/src/index.ts` | KEEP three browser-safe provider export groups; package contract testing is strengthened by WQ-034. |
| `packages/integrations/src/provider-dispatch-fence.ts` | KEEP one shared current-version check plus atomic marker/binding seam; hardening WQ-030. Do not remove the final database fence because a preceding current-version read succeeded. |
| `packages/integrations/src/server-only.ts` | KEEP small Node runtime guard in addition to conditional exports; neither alone proves a transitive browser bundle is clean. |
| `packages/integrations/src/server.ts` | KEEP explicit server-only integration composition/export surface. Export length is not a cohesion defect. |
| `packages/integrations/src/slack/client.ts` | REFACTOR WQ-035: share the identical private response-envelope classification while retaining distinct auth-test/send success contracts. |
| `packages/integrations/src/slack/definition.ts` | KEEP immutable unsafe ABI-2 manifest, exact token slot and policy references. |
| `packages/integrations/src/slack/executor.ts` | KEEP Slack-specific definite-error sets, response-channel binding and unsafe ambiguity decisions; hardening WQ-030, readability tests WQ-034. |
| `packages/integrations/src/slack/index.ts` | KEEP explicit browser-safe Slack manifest and schema exports. |
| `packages/integrations/src/slack/validation.ts` | KEEP strict bounded channel/timestamp/text/token schemas. Repeated policy constants describe separate public constraints; no cross-provider “universal message schema.” |
| `packages/integrations/src/webhooks/crypto.ts` | KEEP webhook purpose binding, exact 32-byte secret ownership and constant-time signature comparison; WQ-033 covers shared cipher and factory admission. Freshness/replay admission belongs to webhook ingress, not this HMAC primitive. |
| `packages/integrations/test/aws-envelope-runtime.test.ts` | KEEP constructor/config/close assertions; WQ-033 adds multibyte admission and companion webhook-factory coverage. Module mock verifies wiring, not real KMS transport timing. |
| `packages/integrations/test/email-send-notification.test.ts` | TEST/REFACTOR WQ-028/WQ-029/WQ-034. Good marker/fence/binding and historical ambiguity assertions; missing malformed-status bodies and historical resolution throttling. The four identical retry iterations do not model persisted retry evolution. |
| `packages/integrations/test/envelope-encryption.test.ts` | TEST WQ-033. Existing round-trip, tamper, malformed KMS response and late-abort key-clearing assertions are useful; they do not observe native decipher temporary buffers. |
| `packages/integrations/test/http-outcome-policy.test.ts` | TEST WQ-034. Focused expected decisions are good; final matrices only assert membership in a set of possible outputs. |
| `packages/integrations/test/http-request.test.ts` | KEEP substantive iterator ownership/fence/artifact tests; WQ-034 splits unrelated scenario bundles, WQ-036 adds normal malformed URLs, WQ-030 adds hostile cleanup errors. Preserve combined primary/cleanup error and exactly-once assertions. |
| `packages/integrations/test/kms-client.test.ts` | KEEP bounded-client option wiring with/without endpoint; do not claim provider timeout qualification from constructor spies. |
| `packages/integrations/test/node-transport.test.ts` | KEEP both lookup callback forms and HTTPS/request-error wiring; WQ-034 corrects cancellation/SNI proof wording or adds the missing behavioral proof. |
| `packages/integrations/test/package-contract.test.ts` | TEST WQ-034: current text scans miss transitive imports and most provider modules. Keep them as narrow checks, add actual browser-entry bundling/import-graph evidence. |
| `packages/integrations/test/retry-after.test.ts` | KEEP named invalid-value and exact clamping tables; seconds/date distinction is explicit. |
| `packages/integrations/test/secure-http.test.ts` | TEST WQ-030/WQ-031/WQ-032/WQ-034. Good controlled DNS, redirect, marker, stream and loopback transport coverage; private DNS redirect is not equivalent to a private literal redirect. |
| `packages/integrations/test/slack-send-message.test.ts` | KEEP provider-specific response matrix and rotation race; WQ-034/WQ-035 make shared parsing coverage and scenarios easier to identify without hiding policy differences. |
| `packages/integrations/test/stream-redaction.test.ts` | KEEP public streaming seam, monotonic deadline control, aborting iterator rejection and timeout classification; WQ-030 extends hostile rejection handling. |
| `packages/integrations/test/webhook-crypto.test.ts` | KEEP exact raw-body HMAC, purpose-bound AAD, caller-secret clearing and late-abort key tests; WQ-033 adds shared temporary-buffer and factory-preflight cases. Freshness belongs to ingress tests, not this primitive. |
| `packages/integrations/test/support/provider-credential-failure-cases.ts` | KEEP one explicit shared behavioral table, not an over-generalized provider test framework. Extend history cases separately where email semantics differ. |
| `packages/integrations/package.json` | KEEP pinned direct dependencies, conditional browser/server exports and existing tsc/Vitest commands. No buildless Node or provider SDK retry changes. |
| `packages/integrations/tsconfig.json` | KEEP composite declarations and node-sdk reference aligned with existing repository build. |
| `packages/integrations/tsconfig.test.json` | KEEP source/test/config checking with no emit and Node/Vitest types. |
| `packages/integrations/vitest.config.ts` | KEEP small local unit configuration. |
| `packages/integrations/vitest.coverage.config.ts` | KEEP explicit full-source coverage and current thresholds; passing thresholds are not proof of complete policy assertions. |

## WQ-028 — P2: preserve refusal status when Resend's body is malformed

Files: `src/email/client.ts:84–110`, `src/email/executor.ts:109–136`,
`test/email-send-notification.test.ts`. Criteria J01/J02/J12.

Current parsing order:

```ts
try { decoded = JSON.parse(decode(response.body)); }
catch { return { kind: 'invalid_response' }; }
// Only afterward inspect success/status and the error envelope.
```

Local probes through the actual client and executor with synthetic HTML bodies
at HTTP **400, 401, 403 and 422** all produced
`retry / provider / possiblyDispatched: true`. ADR 024 explicitly classifies
those statuses as definite failures. The existing cross-client 400 test only
uses a well-formed JSON error and misses this branch.

Plan: on decode/JSON failure, retain status for non-success responses via the
existing `http_failure` variant; reserve `invalid_response` for an invalid
success envelope. Preserve the status-first 429 path and parsed 409 error names.
No public result-union expansion or new provider policy is necessary.

Acceptance: table-test all four refusal statuses with empty, invalid UTF-8,
malformed JSON and valid unknown JSON bodies through client **and** executor;
401/403 remain authentication failures, 400/422 provider failures, with no
automatic retry and cleared byte buffers. Keep malformed 2xx retryable under
the identical email idempotency key, 5xx retryable, and historical uncertainty
dominant when present. No live email is required.

## WQ-029 — P2: make historical dispatch uncertainty a consistent precedence rule

Files: `src/email/executor.ts:94–106,139–163,195–223`,
`test/email-send-notification.test.ts`; inspect node-attempt completion callers
before changing behavior. Criteria J01/J02/J03/J12.

The resolution catch recognizes `ProviderExecutionRateLimitError` before
checking `runtime.providerDispatchUnresolved`. A current-source probe with an
unresolved previous dispatch and a seven-second resolution throttle produced
`retry / rate_limit / possiblyDispatched: false`. The neighboring ordinary
resolution failure and current provider 429 paths preserve previous uncertainty.
The current attempt sending no bytes cannot disprove the previous attempt.

Plan: write an explicit precedence table for resolution failures (invalid
credential, throttled, canceled, transient), crossed with historical uncertainty.
Route the throttled historical case through the existing history-preserving
outcome policy instead of reporting `false`. Review resolved-credential
identity/decode failures too: `withEmailCredential` currently lacks historical
context and constructs definite failures. Add public-boundary tests before
changing those branches. Do not blindly put one history guard ahead of every
branch: accepted email cancellation and successful idempotent replay remain
separate contracts. Collapse `credentialFailure` into the existing parameterized
identity helper only if the resulting call site is clearer.

Acceptance: ordinary throttle still exposes 7,000 ms and definite no-dispatch;
historical throttle never erases prior uncertainty; no provider call occurs on
resolution failure. Preserve existing binding-mismatch/authentication categories,
opaque errors and secret clearing. Add a completion-boundary regression proving
the historical flag is not lost in the persisted observation; do not claim a
durable production incident from the adapter probe alone.

## WQ-030 — P2: ensure error classification cannot strand async work

Files: `src/http/secure-http.ts:619–658` and its classification catches;
`src/http/secure-http-error.ts:isTimeoutError/abortFailure`;
`src/http/stream-redaction.ts:catch/mapResponseStreamError`;
`src/http/secure-http-request.ts:parseRequest`;
`src/provider-dispatch-fence.ts`; the three executor catch boundaries, including
`http-request/executor.ts:preserveBodyFailureDuringCleanup`. Criteria J06–J09/J12.

Current rejection callback removes its abort listener, then evaluates:

```ts
reject(error instanceof Error ? error : new Error('Secure HTTP operation failed'));
```

A transport rejecting a Proxy whose `getPrototypeOf` throws caused an unhandled
`prototype-trap` rejection from the ignored derived promise. The public request
remained unsettled after an event-loop turn; aborting afterward could not settle
it because the listener had already been removed. The isolated probe ended with
Node's unsettled-top-level-await warning. This is not merely a changed error name.

Plan: make normalization total with guarded inspection and make both work and
abort callbacks non-throwing. Observe already-started operations even when
cancellation already won. Protect `instanceof`, `name`, `code` and abort-reason
inspection wherever unknown dependency errors enter the same boundary. Preserve
genuine safe `SecureHttpError` and allowed consumer-error identity; opaque network
errors must not acquire raw secret-bearing causes. Use a narrow private helper,
not a repository-wide error framework. Coordinate with WQ-022's same class of
bug without merging unrelated artifact/network contracts.

Acceptance: isolated tests for primitive rejection, revoked/hostile Proxy,
throwing error `name`/`code`, hostile abort reason, pre-aborted work and an
operation that aborts synchronously before returning its promise. Every request
settles once, late rejection is observed, listeners are removed, no unhandled
rejection/uncaught callback is created, and classification retains current
dispatch truth. Also cover a sole and combined hostile iterator-cleanup failure.
Do not install a process-wide swallowing handler in the regular test runner.

## WQ-031 — P2: preserve dispatch context for blocked redirect literals

Files: `src/http/secure-http.ts:392–436,503–511`,
`test/secure-http.test.ts`. Criteria J01/J03/J09/J12.

`literalAddressFamily` constructs `ssrf_blocked` with hard-coded
`possiblyDispatched: false`; `resolvePublic` rethrows it unchanged. After one
successful dispatch to an HTTP public hostname, a 307 to `http://127.0.0.1/`
produced `{ code: 'ssrf_blocked', possiblyDispatched: false }` with one recorded
transport call. Private DNS answers on the same hop correctly use the caller's
dispatch context. The redirect remained blocked: this is an evidence-truth bug,
**not an SSRF bypass**. Credential-bearing cross-origin redirects have an earlier
independent rejection guard.

Plan: keep literal detection pure (`isIP` family) and perform all public-address
validation under `resolvePublic`'s supplied failure context, or explicitly pass
that context into the literal validator. Avoid a second policy implementation.

Acceptance: initial private literal remains blocked with zero dispatch/false;
private literal after a permitted public hop is blocked with one dispatch/true;
private DNS, family mismatch, public literal without DNS, IPv4 alternative
spellings and IPv6 literal cases remain correct. No retry-policy relaxation.

## WQ-032 — P2 TEST/CONDITIONAL: account for late transport responses

Files: `src/http/secure-http.ts:executeOwnedRequest/raceWithSignal`,
`src/http/node-transport.ts`, `test/secure-http.test.ts`,
`test/node-transport.test.ts`. Criteria J07/J12.

A controlled transport returned its response only after caller abort had already
rejected the public request. Its `close()` count remained **zero**. The generic
race forwards every eventual fulfillment to an already-settled promise, with no
late-value disposal hook. This proves an injectable-adapter ownership gap, not
a leaked native Node socket: the native transport receives the abort signal and
may already destroy the corresponding request/response.

Plan gate: add contract tests for abort before a transport response, fulfillment
after abort, fulfillment/abort in adjacent microtasks, late rejection and normal
success. Establish explicit ownership: if the client accepts an acquired
response, it must close it even after its caller has stopped waiting; if the
transport guarantees disposal before relinquishing it, document/test that
guarantee. Prefer a transport-specific late-result disposer over adding generic
disposal obligations to DNS/body-consumer values. KEEP native code if it already
meets its contract; change the coordinator only where the contract test fails.

Acceptance: close/disposal happens exactly once per owned response, success is
not prematurely closed, errors remain observed, and canceled public calls do
not claim underlying work has necessarily stopped. Keep the durable
`beforeDispatch` marker wait: a marker may still commit and must not be reported
as a definite pre-dispatch cancellation.

## WQ-033 — P2: make crypto temporary ownership and preflight bounds explicit

Files: `src/crypto/envelope-cipher.ts:108–122,337–407`,
`src/credentials/envelope-encryption.ts`, `src/webhooks/crypto.ts`,
`src/credentials/aws-envelope-runtime.ts`; their encryption/factory tests.
Criteria J06/J07/J09/J11/J12.

Current decryption:

```ts
plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
// finally clears plaintext, but not the update() buffer copied into it.
```

An isolated probe wrapping the real Node decipher with **synthetic secret bytes**
observed the `update()` buffer still nonzero after successful `open()` and after
a tampered tag caused `final()` to throw. On the latter path `plaintext` was
never assigned. No unauthenticated plaintext is returned to callers: this is
incomplete memory hygiene, not an authentication bypass. Node documents that
`update()` may return plaintext before authenticity is established at `final()`.
[Node crypto contract](https://nodejs.org/docs/latest-v24.x/api/crypto.html#decipherupdatedata-inputencoding-outputencoding).

Plan: own the update and final buffers explicitly and clear each in `finally`,
including finalization failure; copy/return only authenticated output. Preserve
the returned caller-owned plaintext and connection-vs-webhook seal ownership.
Test the actual core through both wrappers and one narrowly isolated native
buffer spy; do not add production dependency injection solely for this test.

In the same focused cipher pass, decode and validate all bounded envelope
components **before** KMS decryption. A malformed nonempty nonce (`'@'`) currently
causes one KMS decrypt call before rejection. `decode` also allocates from a
base64url string before checking the decoded maximum. Add a cheap encoded-length
ceiling derived from the decoded limit before regex/decode, then retain canonical
round-trip checks. Database connection envelopes already have encoded ceilings;
do not claim an unbounded remotely reachable credential payload from this core
alone. Validate configured key-reference UTF-8 bounds before creating an owned
KMS client; test webhook factory admission as well as connection admission.

Acceptance: authenticated round trips and existing AAD/purpose/tenant tamper
checks unchanged; update/final/key copies zero on success, tag failure and abort;
returned plaintext remains intact; malformed local envelope material causes zero
KMS calls; exact maximum canonical base64url accepted, one-byte excess rejected
before decode allocation; failed factory admission allocates no client. Keep
opaque error messages and no secret-bearing causes. No cipher/provider/format
change or ADR is needed for these contract-preserving repairs.

## WQ-034 — P2: make integration tests diagnostic and policy-sensitive

Files: `test/http-outcome-policy.test.ts:155–193`,
`test/package-contract.test.ts`, `test/node-transport.test.ts`,
`test/email-send-notification.test.ts`, `test/http-request.test.ts`,
`test/slack-send-message.test.ts`, `test/secure-http.test.ts`. Criteria J02/J12/J13.

The final outcome matrices only test that `decision.kind` belongs to the set of
all plausible outputs. Replacing many classifications with `failed` would still
pass those matrices. Several large tests bundle independent admission,
transport, credential and artifact scenarios, while titles such as
`rejects invalid input ... $url` render poorly for rows without a URL. Repeating
the email 429 fixture four times changes no attempt state and is not a persisted
retry test. The package browser test scans only selected immediate source files.
The mocked HTTPS test proves passing the hostname to `https.request`, not a real
TLS/SNI handshake; cancellation is mostly signal forwarding, not disposal proof.

Plan:

1. Replace membership-only policy matrices with named cases and exact expected
   kind, error kind and key-reuse values, deriving expectations from ADR 007's
   decision rules rather than invoking the implementation as its own oracle.
   Keep separate narrow tests for exhaustiveness/unreachable behavior.
2. Split unrelated scenario bundles into named tests or `it.each` records with
   an explicit `name`. Share a small runtime/stream fixture only where it removes
   repeated setup; keep marker-before-I/O, secret clearing and cleanup assertions
   at the behavior seam. Split suites by validation/client/executor/stream
   ownership, not arbitrary line counts or `part-2` filenames.
3. Replace the four identical 429 iterations with one honest adapter case plus
   a completion/claim integration test if persisted retry evolution is claimed.
4. Add a real browser-entry build/import-graph check across all three providers,
   including transitive imports; use existing repository tooling, not a new
   frontend stack. Retain conditional-export assertions.
5. Name mocked transport tests according to what they prove. If adding native
   cancellation/TLS evidence, use a bounded local fixture with deterministic
   disposal, never a live service. Keep the existing loopback pinning proof.

Acceptance: meaningful policy mutations fail exact assertions, each failing row
identifies its scenario, all original ownership/identity assertions survive,
fixtures do not silently reuse zeroed credential buffers, and the package still
passes its normal tests/typecheck/coverage configuration. Wall-clock redaction
smoke bounds should remain generous; use latches for scheduling relationships.

## WQ-035 — P3: share Slack envelope parsing without merging provider policies

Files: `src/slack/client.ts:createSlackClient`, `src/email/executor.ts:109–136`,
the respective provider tests. Criteria J02/J05/J12.

Slack `sendMessage` and `authTest` independently repeat 429 handling, non-2xx
handling, UTF-8/JSON parsing, `ok/error` discrimination and safe error validation.
Only their successful payload requirements differ. A private response-envelope
parser can return a validated success envelope or the existing failure variants;
each operation then maps its own success fields. Request construction and
response-buffer ownership stay at their current client boundary. Do not invent
a configurable “universal provider adapter.”

While touching email classification for WQ-028/WQ-029, remove the
`concurrent_idempotent_requests` branch that returns exactly the same outcome as
the immediately following fallback, or retain its policy explanation as a short
comment and explicit regression case. Do not obscure the meaningful
`invalid_idempotent_request` distinction.

Acceptance: both Slack operations cover rate limiting, malformed UTF-8/JSON,
missing/invalid `ok`, missing error and valid rejection. Auth-test `{ok:true}`
succeeds without channel/timestamp; send-message still requires both and binds
the returned channel. Every response/request buffer is cleared on all existing
paths, and email retry outcomes remain unchanged except the separately approved
correctness findings.

## WQ-036 — P2: keep ordinary URL validation non-throwing

Files: `src/http-request/validation.ts:httpRequestConfigSchema` (URL refinement),
`test/http-request.test.ts`; inspect authoring/preview schema consumers during
their area reviews. Criteria J01/J06/J12.

The `.url()` check is followed by a refinement that calls `new URL(value)` without
a guard. A direct current-source call to `httpRequestConfigSchema.safeParse`
with otherwise-valid config and `url: 'not-a-url'` threw `TypeError: Invalid URL`
instead of returning `{success:false}`. Zod's earlier format failure does not
guarantee this later refinement is skipped. Executor parsing has an outer catch,
so do not claim every invocation escapes; the exported browser/authoring schema
itself violates its normal validation boundary.

Plan: use a non-throwing parse inside the refinement and return false for invalid
syntax; preserve HTTPS, no credentials/fragments, sensitive query-name rejection
and UTF-8 URL bound. Avoid a browser-incompatible Node URL helper or assuming
unchecked Zod short-circuit semantics.

Acceptance: direct `safeParse` of malformed/relative/empty URLs never throws and
returns invalid; valid HTTPS accepted; forbidden schemes, credentials, fragments,
credential-like query keys and byte overflow rejected. Executor still returns its
existing configuration failure with zero connection/provider calls. Add one
authoring/preview consumer regression after inspecting its actual boundary.

## Implementation units and order

1. WQ-036 and WQ-028 as separate small bug-fix/regression units.
2. WQ-029 with its completion-boundary evidence; keep cross-package truth with
   the primary implementer rather than parallelizing policy decisions.
3. WQ-030 async safety; then WQ-031 context propagation and WQ-032's ownership
   contract gate. Do not combine all changes into a new request framework.
4. WQ-033 as a focused cipher/preflight unit with native temporary-buffer proof.
5. WQ-034 oracle/scenario improvements, then WQ-035 local parsing simplification.

Run the package unit suite and typecheck for each relevant unit; run affected
worker/database tests when completion truth is involved. Browser isolation and
coverage checks remain additional gates. No commits or implementation are
authorized by this review ledger.
