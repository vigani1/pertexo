# `@pertexo/integrations` implementation and architecture audit

## Review identity and conclusion

- **Audited commit:** `7e4b37840a2b86c591046e16f1de834e8da2db79`
- **Audited tree:** `8481ebf86f4b36ff70687f86a2bb7933a00d65b8`
- **Production scope:** all 24 source files and all 3,940 physical source
  lines.
- **Test scope:** all 8 test files and all 2,760 physical test lines, direct
  consumers in API, worker, and node catalog, root/package verification, CI,
  coverage controls, the implementation plan, and applicable ADRs.
- **Architecture sources:** the authoritative backend plan; ADRs 001, 007, 010,
  012, 016, 022, 025, and 026; and the credential-boundary operating guide.
- **Audit status:** granularly certified for the pinned tree.
- **Implementation status:** three high-priority correctness/lifecycle issues,
  nine medium security, performance, test, or maintainability issues, and two
  low-priority cleanup/design issues remain open. Two external-provider
  assumptions also remain unverified.

This package is useful and appropriately owns the boundary between platform
node contracts and external provider/network behavior. It contains four deep
capabilities: browser-safe provider definitions, server-only executors and
clients, a security-focused outbound HTTP stack, and managed-KMS envelope
encryption. Those concerns should not be moved into NestJS controllers, the
worker coordinator, or a generic shared-utilities package.

The broad architecture is sound. Browser and server exports are separated;
Slack, Resend, and generic HTTP have explicit schemas and side-effect policies;
the HTTP client pins a validated address, rechecks redirects, bounds traffic,
and redacts output; provider executors resolve credentials just in time and
commit dispatch evidence before sending bytes; connection and webhook secrets
use AES-256-GCM with KMS-wrapped data keys and authenticated identity context.
The package is not overabstracted overall, and three provider folders do not
justify three additional workspace packages today.

Passing tests do not make the package complete. A deterministic execution probe
proved that `SecureHttpClient` can return `timed_out`, `definite_failure`, and
`possiblyDispatched: false`, then allow the still-running `beforeDispatch`
callback to commit durable evidence later. Production API and worker callers
also fail to pass their cancellation signals into KMS operations, so the
package's nominal abort support disappears across the application Seam. In
addition, executor behavior proven with simple fake clients changes when the
real secure-HTTP adapter wraps final-fence errors. These are lifecycle and
semantic defects, not style preferences.

The package needs targeted internal consolidation, not a framework rewrite.
The connection and webhook encryption implementations independently repeat the
same KMS/AES envelope protocol and have already drifted in validation,
cancellation, and input-buffer ownership. A private, parameterized encryption
primitive passes the deletion test. By contrast, the three provider executors
have different outcome and idempotency rules; forcing them under a giant base
class would hide policy and reduce locality.

## Evidence collected

The review combined complete production/test reading, export and internal
callable inventory, repository-wide consumer tracing, plan/ADR comparison,
build/typecheck/lint evidence, package tests, ad hoc V8 coverage, and focused
runtime counterexamples.

| Check | Result |
| --- | --- |
| `pnpm --filter @pertexo/integrations test` | 8 files and 119 tests passed |
| Package typecheck and build | Passed in the repository pre-push gate |
| Repository ESLint and structural checks | Passed in the repository pre-push gate |
| Ad hoc package V8 coverage | 84.40% statements, 74.66% branches, 90.55% functions, 85.99% lines |
| `src/webhooks/crypto.ts` coverage | 57.73% statements, 41.46% branches, 60.00% functions, 58.94% lines |
| `src/slack/client.ts` coverage | 60.86% statements and 42.10% branches |
| `src/http/node-transport.ts` coverage | 59.09% statements and 40.00% branches |
| `src/http/secure-http.ts` coverage | 93.70% statements and 87.23% branches |
| Durable-marker timeout probe | Returned definite pre-dispatch timeout; callback committed afterward; transport remained unused |
| Invalid-header probe | Browser credential schema, node schema, and `SecureHttpClient` accepted `a\u0001b` |
| Real local socket evidence | One Node transport test uses an actual loopback HTTP server |
| Real provider/KMS evidence | None in ordinary, nightly, or release CI |
| Root risk-coverage manifest | No `packages/integrations` cohort or reviewed branch entries |
| Complexity ratchet | Tracks the 808-line secure-HTTP implementation as intentional complexity |

### Granular certification record

This certification read the complete contents of every one of the package's 36
tracked files: all 24 production files (3,940 lines), all 8 test files (2,760
lines), `package.json`, both TypeScript configurations, and the Vitest
configuration (70 lines). It accounted for every exported declaration, schema,
class method, internal helper, encryption and network lifecycle path, provider
executor, test fake, assertion, and package script. Browser/server export seams
and the direct API, worker, and node-catalog consumers were retraced after the
file reading.

The package is byte-for-byte unchanged from the pinned implementation commit.
Fresh evidence produced 8 passing files and 119 passing tests, a passing build
and typecheck, a clean direct ESLint run, and V8 coverage of 84.40% statements,
74.66% branches, 90.55% functions, and 85.99% lines. INT-001 through INT-014 are
the complete findings from this file-level certification, not a top-N list.

Coverage percentages describe executed lines, not behavioral completeness. The
weakest files are precisely the AWS webhook adapter and low-level network
adapter, while the repository's reviewed-branch control covers workflow engine,
database, API, and worker but not integrations. The one local socket test is
valuable transport evidence; the other tests use deterministic HTTP/KMS fakes.

## Architecture, ownership, and dependency direction

### Public Interfaces

The browser-safe root publishes the three node definitions, schemas, limits,
registration metadata, output types, resolved credential schemas, and
`INTEGRATION_MANIFEST_SCHEMA_VERSION`. It does not import Node built-ins, KMS,
or executors. This is the correct dependency boundary for catalog and API
schema consumers.

The `./server` export is guarded by `server-only.ts` and adds:

- connection and webhook envelope-encryption types and implementations;
- AWS KMS key-provider adapters and runtime factories;
- secure HTTP resolver, transport, request/response, error, and outcome policy;
- the Node DNS/HTTP adapter;
- Slack and Resend clients;
- provider executor registrations, typed failures, and telemetry ports; and
- generic HTTP artifact-streaming contracts.

The server surface is larger than ideal, but it exposes actual composition
seams rather than a universal facade. Most consumers import a small subset.
`KmsClientLike`, transport interfaces, and telemetry interfaces enable
deterministic tests without teaching the package about NestJS or worker
internals. Those seams have Leverage and should remain structural rather than
being replaced with mocks of concrete SDK clients.

### Package placement and granularity

The plan sketches `integrations/<provider>/src`, whereas the repository uses
one `@pertexo/integrations` workspace package with provider folders. This is a
minor physical deviation, not an architectural contradiction. There are only
three V1 actions, they share one security-sensitive HTTP boundary, and they are
released with the platform. Creating one package per provider would add
manifests, builds, version relationships, and public seams without independent
ownership or deployment value.

A split becomes justified if a provider gains a distinct SDK dependency,
release cadence, credential lifecycle, webhook subscription service, or worker
isolation requirement. Until then, folders provide sufficient Locality. The
generic HTTP security code and cryptography are shared infrastructure inside
the integration boundary, not providers of their own.

### Dependency direction and consumers

`@pertexo/integrations` depends only on `@pertexo/node-sdk`, Zod, AWS KMS, and
Node APIs. `@pertexo/node-catalog` consumes browser definitions and server
registrations. The API consumes credential and webhook encryption. The worker
consumes encryption, provider executors, secure HTTP, failure-notification
clients, and telemetry types. The package does not depend back on any of them.

The direction is correct, but two promises do not survive composition:

- API and worker operations omit the caller `AbortSignal` when invoking KMS.
- real secure-HTTP wrapping changes some final credential-fence failures from
  typed authentication/configuration outcomes into generic transport outcomes.

This demonstrates why consumer tracing is part of the audit: an isolated
Interface can be well typed while its operational contract is lost one layer
away.

### Recommended internal shape

Keep one public package and the existing provider folders. The following
private ownership seams would improve depth without multiplying public APIs:

```text
src/
  crypto/
    envelope-contract.ts       bounded envelope codec and associated-data port
    envelope-cipher.ts         AES-256-GCM seal/open and zeroization
    aws-kms-key-provider.ts     GenerateDataKey/Decrypt adapter and bounds
  credentials/
    connection-envelope.ts     connection context/policy facade
    aws-envelope-runtime.ts
  webhooks/
    webhook-envelope.ts        webhook context/policy facade
    signature.ts
  http/
    secure-http.ts             small public facade and orchestration
    request-policy.ts          request/header/URL admission
    response-policy.ts         response headers, body bounds, redaction
    address-policy.ts
    node-transport.ts
    outcome-policy.ts
  email/                       existing definition/validation/client/executor
  slack/                       existing definition/validation/client/executor
  http-request/                existing definition/validation/executor
```

Do not create a generic provider executor base class. A small explicit protocol
for cancellation-aware dispatch fencing and typed pre-dispatch rejection is
appropriate because the current seam changes correctness. The encryption
primitive is also justified because deleting either duplicate implementation
would otherwise require recreating KMS/AES/bounds/zeroization behavior.

## Complete production-code review

### `src/server-only.ts`

The four-line import-time guard is appropriate defense in depth for KMS, crypto,
DNS, streams, and provider I/O. Package export conditions remain the primary
browser boundary. The guard has one owner and no unnecessary abstraction.

### `src/index.ts`

The file correctly re-exports only browser-safe definitions and schemas.
`INTEGRATION_MANIFEST_SCHEMA_VERSION` has no manifest envelope and no consumer
anywhere in the repository. It is speculative public API and should be removed
or made the version discriminator of an actual parsed contract. See INT-012.

### `src/server.ts`

The barrel is explicit and readable. It avoids wildcard exports and makes the
server boundary discoverable. Its breadth reflects four cohesive subdomains;
it should not be replaced with a service locator. Long-term, test-only adapter
types can remain file-local exports unless a consumer genuinely composes them.

### `src/credentials/aws-envelope-runtime.ts`

`configSchema` gives connection encryption a strict, bounded region, key ARN,
and optional endpoint contract. `createAwsConnectionEnvelopeEncryption`
constructs and owns the SDK client and returns a closeable runtime. Resource
ownership is clear. The webhook factory should reuse equivalent config
admission instead of accepting malformed values; the two paths currently
drift.

The default KMS client does not declare an application retry budget or request
handler connection/socket bounds. AWS SDK defaults are not an explicit
workflow-attempt deadline. Caller cancellation is supported by the lower
adapter but lost by current consumers. See INT-001 and INT-010.

### `src/credentials/envelope-encryption.ts`

The public `ConnectionSecretContext`, `SealedConnectionSecret`,
`GeneratedEnvelopeKey`, `EnvelopeKeyProvider`, `KmsClientLike`,
`ConnectionSecretEncryptionError`, `AwsKmsEnvelopeKeyProvider`, and
`ConnectionEnvelopeEncryption` form a coherent Interface. KMS commands are
limited to the two operations actually required.

`kmsEncryptionContext` and `connectionSecretAssociatedData` bind workspace,
connection, and secret-version identity both to KMS and GCM. `boundedBytes`,
`decode`, `encode`, and `responseRecord` constrain untrusted SDK/envelope data.
`generate` and `decrypt` pass `abortSignal` through to AWS and check aborts
around local work. `seal`/`open` use fresh 32-byte keys and 12-byte nonces,
validate a 16-byte tag, copy inputs, and clear plaintext keys and transient
plaintext on failure. Opaque errors avoid secret leakage.

The implementation is strong in isolation. The main issues are duplicate
implementation in webhook crypto and absent production signal propagation.
The private helpers belong to an envelope-cipher module, not a repository-wide
crypto utility.

### `src/webhooks/crypto.ts`

Webhook context and sealed-envelope schemas correctly bind workspace, trigger,
and secret-version identity. `encryptionContext`,
`webhookTriggerSecretAssociatedData`, `copyBytes`, `encode`, and `decode`
reimplement the connection envelope protocol. `AwsKmsWebhookEnvelopeKeyProvider`
and `WebhookTriggerEnvelopeEncryption` then duplicate the KMS/AES orchestration.

The duplication has produced observable drift:

- the webhook factory accepts an invalid endpoint URL and validates an empty
  region only through a generic thrown error;
- webhook KMS methods accept and forward an optional signal but, unlike the
  connection implementation, do not check it around local cryptographic work;
- webhook `seal` clears the caller's input buffer, whereas connection `seal`
  copies and preserves it; and
- KMS result validation and test coverage differ.

`verifyWebhookSignature` performs bounded syntax parsing, constant-time HMAC
comparison, and supports current/previous key rotation. Freshness and body-size
admission live at API ingress, where they are correctly enforced. The function
name should continue to imply cryptographic verification only; timestamp replay
admission must remain explicitly tested at the caller.

### `src/email/definition.ts` and `src/email/index.ts`

The definition, executor identity, connection slot, fixed
`idempotent_with_key` policy, manifest, and definition registration are small
and coherent. The index publishes only the intended browser surface. The
manifest pins schemas and credential requirements instead of leaking provider
SDK shapes. This follows the plan.

### `src/email/validation.ts`

Mailbox, subject, body, output, and Resend credential validation are bounded
and purpose-specific. UTF-8 byte limits correctly avoid confusing code-unit
length with payload size. The mailbox parser intentionally supports a bounded
practical subset rather than attempting full RFC email grammar. That policy is
readable and locally owned.

The repeated `utf8Bytes` helper in provider validation files is trivial and
more local than a shared utility. Do not centralize it unless additional
callers acquire a shared policy.

### `src/email/client.ts`

`createResendClient` fixes the endpoint, constructs exactly one bounded request,
uses the stable idempotency key, parses only the small provider result needed by
the platform, clears request bytes, and delegates network safety to
`SecureHttpClient`. `boundedRetryAfter` clamps provider input. It avoids a broad
Resend SDK dependency and has a deep, small client Interface.

The callback/error protocol with secure HTTP is underspecified. A non-
`SecureHttpError` rejection from `beforeDispatch` is converted to
`dispatch_evidence_failed`; direct-client executor tests can therefore prove a
different classification from production. See INT-003.

### `src/email/executor.ts`

`EmailSendNotificationExecutorError`, telemetry, dependencies,
`credentialFailure`, `dispatchIdentityFailure`, `classifyResult`, `execute`,
and the registration factory implement a complete provider node. Configuration,
input, resolved credential, side-effect policy, runtime dispatch identity,
stable provider key, final credential version, and response shape are checked.
Plaintext credentials and message bodies are cleared after use.

The long `execute` procedure is a linear safety protocol. Splitting every
branch into tiny functions would not inherently improve it. However, final
credential assertion and durable dispatch marking need one typed cross-layer
contract. Currently some executor errors are preserved by direct fakes but
wrapped by the real network client. This is a correctness seam, not merely
duplicated syntax.

### `src/slack/definition.ts` and `src/slack/index.ts`

The fixed `unsafe` side-effect class is honest because Slack chat posting does
not provide the required provider-enforced idempotency contract. Manifest,
connection slot, schemas, and registration are complete and browser-safe.
Keeping policy next to the definition makes review easier.

### `src/slack/validation.ts`

Channel ID, message size, provider timestamp, output, and bot-token schemas are
strict and bounded. The bot-token shape is defense in depth after the API wire
schema, as documented by `credential-boundaries.md`. Intentional wire/resolved
schema duplication should remain drift-gated rather than eliminated.

### `src/slack/client.ts`

`createSlackClient` fixes Slack API origins and methods, bounds request data,
uses bearer credentials only as a sensitive value, parses a deliberately small
response, and applies bounded retry-after handling. Separate methods for
posting and authentication testing expose actual provider operations rather
than a generic request escape hatch.

Coverage is weak around provider response/error combinations and retry headers.
No credentialed Slack contract runs in release CI. The implementation therefore
has good local logic but incomplete evidence against provider evolution.

### `src/slack/executor.ts`

The auth, definite, and retryable error sets make policy review explicit.
`classifyResult` and `execute` preserve Slack's unsafe side-effect semantics,
validate runtime identity, resolve/clear credentials, and report bounded output.
The executor is cohesive despite its length.

As with email, errors thrown by the final credential assertion can change type
when passed through the real secure-HTTP client. An unsafe provider may then be
classified through a generic network path rather than the specific fence rule
proven by the fake-client tests. Cross-seam tests are required before treating
the executor suite as production-equivalent.

### `src/http-request/definition.ts` and `src/http-request/index.ts`

The definition publishes a generic integration operation with explicit network
and value policies, header-credential slot, bounded schemas, and server
registration. It is now in the active catalog. A test still calls it a
“candidate” absent from releases but does not assert absence; that description
is stale.

### `src/http-request/validation.ts`

The module bounds URL, body, response, inline output, header count, header
bytes, methods, timeouts, redirects, and configured-versus-credential headers.
It prevents user configuration from setting credential-like or transport-
controlled headers and prevents credentials from controlling content framing.
These are valuable defense-in-depth rules.

`headerValueSchema` rejects CR, LF, and NUL but accepts other prohibited C0
controls and DEL. The same incomplete rule exists in secure HTTP. The browser
contract can therefore accept a value that Node later rejects during header
serialization, after dispatch evidence may have been committed. Header field
values should admit HTAB plus visible/obs-text bytes under one shared policy,
or a deliberately stricter printable subset. See INT-004.

Zod `superRefine` relationships are also not fully representable in generated
JSON Schema. This package's runtime validation is correct for most such cases,
but contract consumers must not mistake generated structural schemas for the
whole semantic policy; this is tracked in the contracts audit.

### `src/http-request/executor.ts`

`requestBody`, `decodeCredential`, `mergeHeaders`, `inlineBody`,
`writeArtifact`, `concatenate`, and `consumeResponseBody` support one cohesive
operation. The executor validates every boundary, separates configured headers
from decrypted credential headers, preserves stable dispatch evidence,
classifies side effects by method, streams large responses to artifacts, and
keeps inline values bounded. Artifact creation receives the execution signal.

The explicit inline/artifact paths are justified. They prevent a 10 MiB body
from being accumulated merely to decide where to store it. The local
`concatenate` helper should not be moved to a generic buffer package.

Executor-owned request bytes are cleared, but `SecureHttpClient.parseRequest`
creates a second body copy and never clears it. The apparent lifecycle guarantee
therefore stops at the adapter boundary. See INT-007.

### `src/http/address-policy.ts`

`normalizeUrlHostname`, `assertPublicAddress`, `ipv4Number`,
`matchesIpv4Prefix`, `ipv6Words`, `parseIpv6Half`, and `matchesIpv6Prefix`
implement a compact fail-closed address policy. Mapped IPv4, loopback,
link-local, private, documentation, benchmarking, multicast, translation, and
other special ranges are rejected. Parsing does not outsource policy to a DNS
library with unclear defaults.

The hard-coded tables are conservative against the current IANA special-purpose
registries, including newer `3fff::/20` treatment, but no generated/pinned
registry evidence or drift alert exists. Some globally reachable exceptions
are intentionally blocked, which is an availability tradeoff. The material
risk is future registry change inside a broadly allowed prefix. See INT-009.

Authoritative registries:
[IANA IPv4 Special-Purpose Address Registry](https://www.iana.org/assignments/iana-ipv4-special-registry)
and
[IANA IPv6 Special-Purpose Address Registry](https://www.iana.org/assignments/iana-ipv6-special-registry).

### `src/http/node-transport.ts`

`NodeDnsResolver` requests all verbatim addresses. `NodeHttpTransport` pins the
selected address through custom lookup while preserving the URL host for Host
and TLS SNI, streams response chunks, propagates abort, and closes sockets.
The local real-server test verifies the basic adapter rather than only a fake.

DNS resolution itself accepts no signal; the caller stops waiting but the OS
lookup can finish later. The request uses `agent: false`, opening a new
connection per provider call. That is security-simple and avoids stale DNS
pooling, but may be expensive at workflow scale. Do not add generic keep-alive
without a design that preserves address pinning and revalidation. Benchmark
first and treat this as an evidence gap, not a confirmed production regression.

### `src/http/outcome-policy.ts`

The side-effect classes and decision union encode ADR 007 directly.
`classifySecureHttpResponse`, `classifySecureHttpError`, `validPolicy`, retry
helpers, and `unreachable` keep unsafe, idempotent-key, safe, definite, and
ambiguous outcomes explicit. Exhaustive switching and stable error kinds are
good TypeScript usage.

The policy is only as accurate as the transport's `possiblyDispatched` and
classification flags. The late-marker race and adapter error wrapping therefore
need fixes at their source; adding exceptions to this otherwise coherent policy
would deepen the wrong seam.

### `src/http/secure-http.ts`: request admission and dispatch

The public error, request, response, resolver, transport, and consumer types
form a useful security boundary. `parseRequest`, `parseTargetUrl`,
`parseRedirectUrl`, `parseHeaders`, `parseSensitiveValues`, and
`literalAddressFamily` enforce bounded input and reject credentials, fragments,
unsafe schemes, framing headers, duplicate normalized headers, and private
literal addresses.

`executeWithBody` validates every DNS answer, sorts deterministically, pins one
address, commits evidence before transport, re-resolves each redirect, rejects
HTTPS downgrade and credential-bearing cross-origin redirects, and closes every
response. The sequence is intentionally linear and should not be fragmented
solely to reduce 808 lines.

There are three concrete issues:

1. `beforeDispatch()` is started and raced against the aggregate signal, but
   it receives no cancellation/deadline and is not awaited to settlement after
   the race rejects. Durable work can complete after a definite failure has
   been returned.
2. non-`SecureHttpError` callback errors are collapsed into
   `dispatch_evidence_failed`, losing typed executor fence semantics.
3. response status validation repeats `response.status < 100` twice. This is
   harmless dead repetition but evidence that the long file needs focused
   cleanup.

### `src/http/secure-http.ts`: redirects, bodies, and redaction

`redirectLocation` and `redirectRequest` correctly preserve bodies only for
307/308 and reject automatic replay of non-GET/HEAD requests for other redirect
codes. `collectBody` and `concatenateBytes` copy buffers deliberately.
`boundedRedactedBody` enforces both raw and emitted byte limits, clears incoming
chunks and pending buffers, and handles secrets split across chunks.
`selectResponseHeaders` allowlists metadata and redacts values. `safeFinalUrl`
returns only origin, preventing query/path secrets from becoming node output.

The redactor is correct for covered cases but algorithmically risky.
`redactAvailable` scans up to 32 patterns at each byte and accumulates a
`number[]`; a one-byte secret repeated in a maximum-size chunk expands every
byte to ten bytes before the emitted-size check runs. This can create very large
transient arrays and CPU cost from one provider-controlled response. Enforce the
output bound while building and use a bounded streaming matcher or byte-chunk
builder. Add worst-case benchmarks and memory tests.

`parseRequest` clones the request body, but no outer `finally` clears that clone.
Redirect transformations retain it until completion. Clearing the executor's
original buffer is therefore incomplete as a best-effort secret lifecycle.

### `src/http/secure-http.ts`: errors and cancellation

`assertNotAborted`, transport/stream mapping, timeout recognition,
`raceWithSignal`, and `abortFailure` provide one stable outward error vocabulary.
Transport and response ambiguity is conservatively classified after dispatch.

`failure` intentionally discards `cause`. Public errors must remain safe, but
complete cause loss leaves no sanitized internal diagnostic seam for DNS,
provider transport, and response-stream failures. Add bounded categorical
observation—not raw errors, URLs, headers, or bodies—at this boundary or prove
that worker telemetry retains enough actionable reason. This is an operability
improvement, not permission to leak provider data.

## Tests, coverage, and CI

### `test/package-contract.test.ts`

The test validates browser/server export shape and server-only isolation. It is
small and useful, but does not assert that every exported constant has a
consumer or that browser modules remain free of transitive server dependencies
through a real browser bundler. Existing repository boundary checks add some of
that evidence.

### `test/envelope-encryption.test.ts`

The connection tests cover round trip, context binding, tampering, malformed
envelopes, bounds, KMS options, cancellation, and opaque errors with both fake
providers and a fake SDK seam. These are meaningful security tests, not tests
written merely for count. They are stronger than webhook encryption tests.

Missing evidence includes a real managed-KMS contract, explicit SDK retry/
timeout policy, and production consumer cancellation. Unit tests of an optional
signal do not prove that applications pass one.

### `test/webhook-crypto.test.ts`

The file covers envelope round trip/context rejection and signature success,
rotation, malformed input, and wrong signatures. At 80 lines it leaves most AWS
adapter, factory, KMS-response, cancellation, buffer-ownership, and malformed
envelope branches untested. This aligns with 41.46% branch coverage and is the
largest package-specific coverage gap.

### `test/http-outcome-policy.test.ts`

The table-driven policy tests exercise safe, unsafe, and idempotent-with-key
decisions across response and error classes. This is appropriate exhaustive
unit testing for a pure decision Module. Keep it data-driven and add cases when
the closed unions change.

### `test/secure-http.test.ts`

This is the strongest suite. It covers public/non-public addresses, mixed DNS
answers, pinning, redirects, downgrade/cross-origin protection, request bounds,
headers, compressed responses, response limits, chunk-split redaction,
consumer/transport failures, cancellation, timeouts, close behavior, and one
real Node HTTP socket.

It misses the late completion of `beforeDispatch`, prohibited control bytes
beyond CR/LF/NUL, worst-case redaction amplification, signal-insensitive DNS
completion, connection reuse behavior, and several Node adapter branches. Add
regressions based on INT-002, INT-004, INT-007, and INT-008 rather than pursuing
an arbitrary percentage alone.

### `test/http-request.test.ts`

The file meaningfully covers schemas, header merging, credential handling,
side-effect classification, inline versus artifact output, response streaming,
artifact failure, dispatch identity, retries, and secret clearing. Most cases
use a fake HTTP client; one final-fence case does use `SecureHttpClient` and
demonstrates the current generic internal classification. It does not cover all
typed fence outcomes. The “candidate definition”/“absent from any release”
title is stale because the catalog now registers HTTP Request.

### `test/slack-send-message.test.ts`

The suite covers manifest/schema, client requests, credential parsing, provider
errors, retry behavior, dispatch identity, side-effect policy, and telemetry.
The client file's 42.10% branch coverage shows that its provider-response matrix
is still incomplete. Most importantly, the executor fake bypasses real secure-
HTTP callback error wrapping.

### `test/email-send-notification.test.ts`

This is the largest provider suite and covers mailbox/schema bounds, client
requests, provider results, idempotency, credential rotation, retry horizon,
dispatch binding, telemetry, and secret cleanup. The breadth is useful, and one
compact group composes the real client with a fake resolver/transport. That
group covers runtime dispatch-evidence errors but not rejection from the
preceding `assertCurrent` call, and Slack still has no equivalent composition
case. Extend this matrix instead of duplicating more direct-fake cases.

### Coverage enforcement

There is no package `vitest.coverage.config.ts`, no package coverage script,
and no integrations cohort in `risk-coverage-reviews.json`. Ordinary CI runs
the tests but does not fail on coverage regression in this package. The root
risk report's 116 reviewed and 0 unreviewed branches therefore says nothing
about integrations.

Introduce a package coverage configuration with ratcheted per-file floors for
security-critical crypto, address, secure-HTTP, and provider-client files. Add
branch review only for genuinely unreachable or defensive cases; do not use it
to excuse feasible tests. The initial ratchet must expose the webhook/transport
debt rather than lowering a global number until it disappears.

### CI and provider truth

GitHub CI includes `@pertexo/integrations` in build, typecheck, and package-test
cohorts. This proves deterministic local contracts on every change. It does not
run real Slack, Resend, or AWS KMS. The plan explicitly calls for mocked HTTP
boundaries plus gated credentialed provider suites and says nightly/release
pipelines run provider contracts. The latter is absent.

Do not place side-effecting credentialed provider tests in every pull request.
Create manually dispatched or protected scheduled tests against dedicated
sandbox accounts, bounded recipients/channels, low quotas, and non-production
KMS keys. Record provider API/version, region, timestamp, and sanitized result.
Until that exists, provider compatibility and managed-KMS behavior are
unverified production assumptions.

## Plan and ADR compliance

The package substantially implements the plan's intended provider slice:

- generic HTTP, Slack, and email are complete manifest/executor pairs in the
  publishable catalog;
- manifests and server operations are separated;
- no giant provider base class or microservice-per-integration exists;
- provider inputs, outputs, credentials, retries, and observations are bounded;
- generic HTTP applies scheme, DNS, address pinning, redirect, downgrade,
  compression, size, redaction, timeout, and outcome controls;
- workers receive references and resolve credentials just in time;
- Slack declares unsafe semantics and Resend uses a stable idempotency key;
- webhook secrets are encrypted and signatures use rotation-aware verification;
  and
- provider code remains outside the API process for node execution.

The plan is not contradicted by keeping provider folders in one workspace
package. The implementation deviates or lacks evidence in these areas:

- dispatch evidence can commit after a definite timeout, violating the ordering
  and truthfulness required by ADRs 007, 016, and 025;
- application cancellation is not propagated into managed KMS despite the plan's
  bounded external-call requirement;
- provider executor tests do not cover every real HTTP/fence composition;
- gated credentialed provider suites required by the testing strategy do not
  exist; and
- registry-driven SSRF maintenance and worst-case response redaction are not
  continuously verified.

The plan was directionally correct for this package. The new findings mostly
arise from implementation details and missing continuous evidence, not from a
conflict between the plan and modern code quality.

## Findings

### INT-001 — Production callers drop KMS cancellation and deadline control

- **Severity:** P1
- **Classification:** confirmed defect
- **Evidence:** connection encryption accepts a signal and passes it as the AWS
  SDK `abortSignal`, but API connection use cases and webhook service call
  `seal`/`open` without one. The worker connection resolver receives
  `input.signal` and calls `encryption.open` without forwarding it. Webhook
  encryption accepts a signal, but API management and ingress callers omit it.
  The default KMS client also has no explicit retry or socket/request budget.
- **Impact:** a canceled or expired request/attempt can retain an unsettled KMS
  call and resource ownership beyond its lifecycle. Worker lease/retry timing
  can diverge from credential resolution.
- **Remediation:** make signal/deadline required at application encryption
  ports; forward worker/API signals; add webhook pre/post-local-work abort
  checks; configure a bounded SDK retry and HTTP handler policy within the
  aggregate operation deadline.
- **Verification:** API and worker integration tests with a KMS fake that blocks
  until aborted; assert no late state transition and bounded completion.
- **Status:** open.

### INT-002 — A dispatch marker can commit after a definite pre-dispatch timeout

- **Severity:** P1
- **Classification:** confirmed defect
- **Evidence:** `executeWithBody` races `parsed.beforeDispatch()` against
  `executionSignal` but cannot cancel the callback and does not await its final
  settlement. A deterministic probe returned `{code:"timed_out",
  classification:"definite_failure", possiblyDispatched:false,
  committed:false}`, then after releasing the callback observed
  `committed:true`; transport dispatch count stayed zero.
- **Impact:** durable evidence can say dispatching after the caller recorded a
  definite no-dispatch failure. Recovery/retry logic may infer ambiguity from a
  provider call that never occurred.
- **Remediation:** define a cancellation-aware bounded fence contract and make
  timeout ownership explicit. If durable commit cannot be canceled safely,
  await its authoritative result before classifying; never return a definite
  pre-dispatch result while the marker can still commit.
- **Verification:** a real repository-backed fence integration with timeout at
  each pre/post-commit point; assert persisted evidence and reported outcome
  cannot contradict.
- **Status:** open.

### INT-003 — Final-fence error meaning changes through the real HTTP adapter

- **Severity:** P1
- **Classification:** confirmed defect
- **Evidence:** provider executor tests use clients that invoke
  `beforeDispatch` directly, preserving executor errors. `SecureHttpClient`
  preserves only `SecureHttpError`; every other callback rejection becomes
  `dispatch_evidence_failed`. Email explicitly translates some node-dispatch
  errors, but its final credential assertion can throw an executor error. Slack
  has the same cross-layer mismatch.
- **Impact:** authentication, rotation, binding, and fencing failures can be
  misclassified as retryable network/internal outcomes in production. Unsafe
  Slack and idempotent email can follow policy different from their tests.
- **Remediation:** introduce one narrow typed pre-dispatch result/error protocol
  understood by secure HTTP and executors. Keep provider-specific policy in the
  executor; do not expose arbitrary error causes.
- **Verification:** composition tests for HTTP, Slack, and email using real
  clients plus fake resolver/transport, covering every fence rejection and
  asserting zero transport calls and exact outcome classification.
- **Status:** open.

### INT-004 — Header schemas admit invalid control bytes

- **Severity:** P2
- **Classification:** confirmed defect
- **Evidence:** `httpRequestHeadersSchema`, resolved credential headers, and
  secure HTTP reject only CR/LF/NUL. A runtime probe accepted `a\u0001b` at all
  three layers. Node rejects such a header during serialization.
- **Impact:** an accepted workflow/credential can fail only after dispatch
  evidence is committed, creating false ambiguity and inconsistent browser/
  server validation.
- **Remediation:** define one package-local field-value policy that rejects C0
  controls except optional HTAB and rejects DEL; use it in both validation
  modules and keep framing-header policies separate.
- **Verification:** table tests over all bytes 0x00-0x1f and 0x7f plus a real
  Node transport test proving every admitted value serializes.
- **Status:** open; cross-reference CON-007.

### INT-005 — Two envelope-encryption implementations duplicate and drift

- **Severity:** P2
- **Classification:** maintainability improvement with current behavioral drift
- **Evidence:** 378-line connection encryption and 316-line webhook crypto each
  implement KMS GenerateDataKey/Decrypt, AES-256-GCM, base64url codecs,
  associated context, bounds, factories, and zeroization. Configuration,
  cancellation, caller-buffer ownership, KMS result validation, and coverage
  differ.
- **Impact:** security fixes must be made twice and currently provide different
  guarantees for equally sensitive envelope operations.
- **Remediation:** extract a private parameterized envelope cipher and AWS KMS
  provider; retain distinct connection/webhook context schemas, error facades,
  limits, and public types.
- **Verification:** shared conformance matrix plus domain-specific tests;
  mutation tests for context/tag/ciphertext and explicit caller-buffer contract.
- **Status:** open.

### INT-006 — Security-critical integration branches have no coverage ratchet

- **Severity:** P2
- **Classification:** maintainability improvement
- **Evidence:** package branch coverage is 74.66%; webhook crypto is 41.46%,
  Slack client 42.10%, and Node transport 40.00%. There is no package coverage
  config or risk-review cohort.
- **Impact:** regression in crypto/KMS/provider/network branches can merge while
  all enforced checks remain green.
- **Remediation:** add per-file ratchets and targeted risk cases; review only
  infeasible branches with fingerprints and reasons.
- **Verification:** CI fails when a covered risk branch is removed or a new
  unreviewed branch appears.
- **Status:** open.

### INT-007 — The secure HTTP request-body copy is not cleared

- **Severity:** P2
- **Classification:** confirmed defect
- **Evidence:** `parseRequest` creates `new Uint8Array(parsed.body)`. Provider
  executors clear their original buffer, but no outer `finally` clears the
  secure-client copy.
- **Impact:** credential-like generic HTTP bodies remain reachable for the
  request lifecycle and rely solely on garbage collection despite explicit
  best-effort clearing elsewhere.
- **Remediation:** own the cloned buffer in `executeWithBody` and clear it in an
  outer `finally`, including redirects, cancellation, and parse/transport
  failure. Document that JS cannot guarantee physical memory erasure.
- **Verification:** inject/inspect a transport-visible buffer and assert it is
  zeroed after success, redirect rejection, timeout, cancellation, and failure.
- **Status:** open.

### INT-008 — Redaction can amplify provider input before enforcing its bound

- **Severity:** P2
- **Classification:** confirmed performance/resource defect
- **Evidence:** `redactAvailable` scans up to 32 patterns per byte and appends
  the ten bytes of `[Redacted]` to a `number[]` for every match. Emitted-size
  enforcement occurs only after constructing the result. A one-byte secret in
  a large chunk creates roughly tenfold output plus boxed-array overhead.
- **Impact:** a bounded 10 MiB provider response can cause disproportionate CPU
  and transient memory use inside a worker.
- **Remediation:** enforce the remaining output budget during matching and use
  bounded byte chunks or a streaming multi-pattern matcher.
- **Verification:** worst-case 1-byte, overlapping, 32-pattern, and cross-chunk
  benchmarks with hard memory/time ceilings.
- **Status:** open.

### INT-009 — SSRF special-address policy has no registry-drift control

- **Severity:** P2
- **Classification:** continuous control
- **Evidence:** address ranges are hand-maintained. They are conservative
  against the currently published IANA registries, but no pinned registry date,
  generated snapshot, or scheduled diff exists.
- **Impact:** a future non-global allocation inside an allowed broad IPv6 range
  could silently become reachable.
- **Remediation:** record the source/version and add scheduled registry drift
  review or generate checked policy fixtures from a pinned normalized snapshot.
  Require human review for changed global/reachability semantics.
- **Verification:** CI compares source policy fixtures with the approved
  snapshot; a scheduled job reports upstream changes.
- **Status:** currently safe, control open.

### INT-010 — External provider and managed-KMS contracts are unverified

- **Severity:** P2
- **Classification:** unverified production assumption
- **Evidence:** all Slack/Resend/KMS tests use fakes; CI has no gated
  credentialed provider suite despite the plan requiring nightly/release
  provider contracts.
- **Impact:** request headers, response/error schemas, idempotency behavior,
  retry hints, KMS permissions, endpoint/region behavior, and SDK compatibility
  can drift without repository evidence.
- **Remediation:** protected scheduled/manual sandbox suites with bounded side
  effects and sanitized evidence. Never use production destinations or secrets.
- **Verification:** release evidence records successful Slack, Resend, and KMS
  contract checks or an explicit approved exception.
- **Status:** open external evidence gap.

### INT-011 — Network failure diagnostics are too shallow

- **Severity:** P2
- **Classification:** maintainability improvement
- **Evidence:** `failure` discards every cause. Public safety is correct, but
  DNS, connect, TLS, stream, timeout, and policy failures lack a package-level
  bounded diagnostic/observation channel.
- **Impact:** operators see a broad stable code but may lack enough safe detail
  to distinguish provider outage, DNS failure, TLS/configuration, or adapter
  defect.
- **Remediation:** emit enumerated stage/reason/latency observations with no URL
  path/query, IP unless policy-approved, headers, bodies, credentials, or raw
  exception messages.
- **Verification:** telemetry tests assert useful dimensions and forbidden-data
  absence for every failure stage.
- **Status:** open.

### INT-012 — Public/version and test language contains obsolete intent

- **Severity:** P3
- **Classification:** maintainability improvement
- **Evidence:** `INTEGRATION_MANIFEST_SCHEMA_VERSION` is unused. The HTTP test
  calls the node a candidate absent from releases even though node catalog
  registers it, and the test does not assert its stated absence.
- **Impact:** dead public API and stale descriptions mislead maintainers about
  current release state.
- **Remediation:** remove the constant or attach it to a parsed envelope; rename
  and correct the test assertion to current catalog behavior. Remove the
  duplicated status comparison in secure HTTP.
- **Verification:** repository symbol search and updated test names/assertions.
- **Status:** open.

### INT-013 — DNS and connection lifecycle needs measured production policy

- **Severity:** P3
- **Classification:** unverified performance assumption
- **Evidence:** DNS resolution cannot be canceled and `agent: false` disables
  connection reuse. This is safe and deterministic but may impose one DNS/TCP/
  TLS lifecycle per provider request.
- **Impact:** throughput and latency may degrade at scale; naïve pooling could
  instead weaken DNS-rebinding protection.
- **Remediation:** benchmark realistic concurrency and provider latency. If
  justified, design origin-and-pinned-address-scoped pooling with bounded age,
  explicit close ownership, DNS revalidation, and TLS-host preservation.
- **Verification:** load test before/after with SSRF rebinding regression tests.
- **Status:** open evidence gap; no refactor until measured.

### INT-014 — HTTP executor leaks raw schema errors outside its failure contract

- **Severity:** P2
- **Classification:** confirmed defect
- **Evidence:** `executeHttpRequest` parses invocation config and input before
  entering any translation boundary. A direct registration probe with invalid
  config rejects with `ZodError`, not `HttpRequestExecutorError` or another
  `NodeExecutorFailure`. The email and Slack executors translate equivalent
  admission failures to a bounded configuration outcome.
- **Impact:** malformed or version-skewed persisted input can be reported as an
  unexpected internal exception instead of a stable non-retryable configuration
  failure, producing inconsistent engine and telemetry behavior across
  integrations.
- **Remediation:** catch both invocation schema parses at the executor boundary
  and throw `failedConfiguration`; keep detailed Zod issues out of runtime
  errors because values may contain user data.
- **Verification:** table-test invalid config, input, unknown fields, and bounds
  through the registration's public `execute` function; every case must produce
  the same typed, definite, pre-dispatch configuration outcome and zero
  credential/network calls.
- **Status:** open.

## What should remain unchanged

- Keep browser and server export boundaries explicit.
- Keep one integrations workspace package until ownership or deployment creates
  a genuine package seam.
- Keep provider-specific outcome and idempotency policy visible; do not create a
  giant provider base class.
- Keep fixed Slack/Resend endpoints and the generic HTTP security boundary.
- Keep DNS validation of every answer and address pinning through transport.
- Keep redirect re-resolution, HTTPS downgrade rejection, and credential-origin
  restrictions.
- Keep bounded streaming artifact output and origin-only final URLs.
- Keep opaque public errors and double credential validation at wire and
  resolved boundaries.
- Keep AES-GCM associated data and KMS encryption contexts bound to domain
  identity.
- Keep long linear safety protocols intact unless a proposed seam improves
  ownership, testability, or correctness with equivalent evidence.

## Recommended implementation order

1. Fix INT-002 and INT-003 together by defining and integration-testing the
   durable pre-dispatch protocol.
2. Fix INT-001 by propagating cancellation/deadlines across API, worker,
   webhook crypto, and KMS configuration.
3. Fix INT-004 before other header work because it can create false dispatch
   evidence, and normalize HTTP executor admission failures under INT-014.
4. Add INT-006 risk/coverage ratchets and regression tests for the preceding
   correctness fixes.
5. Consolidate envelope internals for INT-005 while preserving distinct public
   domain contracts.
6. Fix INT-007 and INT-008, then run adversarial body/redaction benchmarks.
7. Establish INT-009 and INT-010 continuous external evidence.
8. Add safe diagnostics for INT-011 and clean INT-012.
9. Measure INT-013; change transport resource policy only if evidence supports
   it.

Completion requires code, targeted regression/integration evidence, green
repository checks, and updated status in this audit. A passing 119-test package
suite by itself is not completion.
