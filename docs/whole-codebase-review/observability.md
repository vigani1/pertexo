# Observability: complete file-by-file judgment

All 28 inventory files read and judged against J01–J14. Existing package suite
passed: 12 files / 71 tests, including local HTTP/in-memory export tests. No
external telemetry collector was contacted or qualified by this review.

## File ledger

Paths are relative to `packages/observability/`.

| File | Judgment | Concrete reason / action |
| --- | --- | --- |
| `packages/observability/src/config.ts` | KEEP | Strict exporter configuration, cross-field header requirement and frozen result are clear; environment validation is not mixed with SDK lifecycle. |
| `packages/observability/src/index.ts` | KEEP | Public root deliberately excludes transport metrics; supported deep exports remain separate. |
| `packages/observability/src/logger.ts` | FIX WQ-018; REFACTOR/FIX WQ-020 | Error argument inspection can escape; record enumeration precedes the advertised entry cap. Preserve fixed service fields, secret policy and correlation behavior. |
| `packages/observability/src/maintenance-metrics.ts` | KEEP | Four named instruments with bounded typed dimensions and validation before recording; explicit methods communicate metric semantics. |
| `packages/observability/src/nest-runtime.ts` | FIX WQ-018, WQ-019 | Proxy classification can throw, and pre-redaction truncation can expose a URL password prefix. Keep Nest adapter and common registration seam; do not introduce a logging framework. |
| `packages/observability/src/queue-tracing.ts` | KEEP | Fixed span name, validated-parent assumption, no raw exception property reads and preserved original rejection. Arbitrary throwing tracer SDK replacements are not assumed production behavior. |
| `packages/observability/src/runtime.ts` | KEEP | Validated timer range, pre-aborted signal handling and listener cleanup; abort intentionally resolves a shutdown delay rather than rejects a business operation. |
| `packages/observability/src/server-only.ts` | KEEP | Existing Node-only runtime guard. |
| `packages/observability/src/telemetry-sanitization.ts` | KEEP | Local URL components and fixed exception classes hide credentials/query values. Distinct HTTP request shapes justify separate hooks; do not generalize them into unsafe common casts. |
| `packages/observability/src/telemetry.ts` | Existing PF-03 | Failed-start ownership and synchronous shutdown caching already have detailed work in the structural plan. Keep instrumentation wrappers and existing tested privacy behavior; do not double-count. |
| `packages/observability/src/transport-metrics.ts` | KEEP | Large but cohesive instrument registry and typed recording facade. Units/descriptions and different instrument kinds justify explicit construction; no schema-driven metrics generator. TransportJob literals are bounded independent instrumentation vocabulary; application adapters are separately judged in the worker telemetry/transport ledgers. |
| `packages/observability/test/config.test.ts` | KEEP | Table covers strict config, unsafe endpoint protocol and header dependency; tests immutable public result. |
| `packages/observability/test/logger.test.ts` | TEST WQ-018, WQ-020 | Existing hostile-field/message-getter case misses top-level proxy error and post-limit getters; keep emitted-record assertions. |
| `packages/observability/test/maintenance-metrics.test.ts` | KEEP | Verifies fixed labels and no writes after invalid duration, not only thrown error. |
| `packages/observability/test/nest-runtime.test.ts` | TEST WQ-018, WQ-019 | Stack/context overload cases are valuable; add prototype trap and redaction-at-truncation boundary cases. |
| `packages/observability/test/operations-assets.test.ts` | REFACTOR/TEST WQ-021 | One test combines dashboard shape, alert/runbook references, series and emitter coverage, provisioning and label bans; failures obscure independent responsibilities. Text checks are not PromQL/YAML semantic execution. |
| `packages/observability/test/package-contract.test.ts` | KEEP | Browser exclusions and transport-metrics deep-export ownership checked explicitly. |
| `packages/observability/test/queue-tracing.test.ts` | TEST WQ-021 | Good fake and real exporter evidence, including hostile errors; real provider should be shut down in finally. |
| `packages/observability/test/runtime.test.ts` | KEEP | Fake-timer duration and invalid ranges are clear; pre-aborted/listener cleanup assertions are a useful small extension, not a new architecture finding. |
| `packages/observability/test/telemetry-http-sanitization.test.ts` | REFACTOR/TEST WQ-021 | Valuable real instrumentation end-to-end case; large multi-scenario body and sequential cleanup hide which scenario/owner failed. |
| `packages/observability/test/telemetry-non-http-sanitization.test.ts` | KEEP + TEST WQ-021 | Pinned Nest/PG wrapper tests establish non-HTTP privacy; start the cleanup scope before metadata/patch mutation and independently restore all owners. |
| `packages/observability/test/telemetry.test.ts` | Existing PF-03 | Add attempted-start and sync-shutdown regressions as already planned; do not create duplicate lifecycle work. |
| `packages/observability/test/transport-metrics.test.ts` | TEST WQ-021 | Valid sample assertions are concrete; invalid-measurement tests use a no-op default meter and do not establish their “before meter” claim. |
| `packages/observability/package.json` | KEEP | Explicit instrumentation pins and deep exports preserve telemetry-before-application-import composition. |
| `packages/observability/tsconfig.json` | KEEP | Existing build/declaration contract; no native type-stripping migration. |
| `packages/observability/tsconfig.test.json` | KEEP | Shared production compiler behavior with test/config typechecking and no emit. |
| `packages/observability/vitest.config.ts` | KEEP | Node test scope excludes generated output. |
| `packages/observability/vitest.coverage.config.ts` | KEEP | All source included with explicit thresholds; metrics/lifecycle adverse cases still require named tests. |

## WQ-018 — P2: contain unknown-value inspection at logging boundaries

**Locations:** `src/logger.ts`, `errorValue` and its call from
`PinoStructuredLogger.write`; `src/nest-runtime.ts`, `normalize` and
`nestLogError`; corresponding logger/Nest tests.

`errorValue` performs `error instanceof Error` before any catch. A proxy with a
throwing `getPrototypeOf` trap supplied as the public logger error argument
caused `logger.error(...)` to throw `prototype trap` in a current-source probe.
The Nest adapter also performs unguarded `message instanceof Error` twice.
The current test claims hostile error properties never escape but covers only
an actual Error's message getter, which reaches the protected sanitizer.

Use a small guarded normalization boundary returning a fresh fixed
`[Unserializable error]` marker when inspection fails. In Nest, classify once
inside protection and reuse the classification; do not repeatedly inspect the
same unknown object. Preserve normal Error causes, bounded/redacted text,
non-Error fallback and ordinary log output. Do not catch destination write
failures indiscriminately without a separate operational contract.

Tests: top-level proxy error, revoked proxy, nested hostile cause, Nest object
message with prototype trap, and ordinary errors. Assert calls do not throw
from normalization, no trap text is emitted, the safe marker is emitted where
appropriate, and existing useful fields/correlation survive.

## WQ-019 — P1: redaction must survive Nest's shorter truncation boundary

**Locations:** `src/nest-runtime.ts`, `boundedNestText`; `src/logger.ts`,
`redactLogText`/`boundText` integration; `test/nest-runtime.test.ts` and
`test/logger.test.ts`.

Current Nest text flow is raw `slice(0, 1024) + '[Truncated]'`, then redaction.
The URL-userinfo scanner requires a later `@` to recognize a password. A URL
whose userinfo crosses 1024 loses that delimiter before the scanner sees it.
Current-source probe:

```ts
adapter.log('x'.repeat(990) + ' https://u:VISIBLE_SECRET' +
  'p'.repeat(100) + '@host.test');
```

Captured summary contained `https://u:VISIBLE_SECRETppppppppp[Truncated]`.
This proves a synthetic credential-prefix disclosure through the adapter,
not that real credentials have already been logged.

Redact through the already-bounded general text sanitizer before applying the
shorter Nest display limit, or make short-limit truncation token-aware and
fail closed on incomplete credential tokens. Never scan arbitrary unbounded
text just to solve this. Preserve the 1024 display-prefix policy and marker,
stack recognition's independent bounded scan, and safe ordinary messages.

Regression matrix: URL password with `@` before/at/after the display boundary;
long input exceeding the general sanitizer bound; Basic/Bearer, cookie and
key=value values across the boundary; summary, context and stack paths. Assert
no full or partial sentinel secret survives, bounded output, and existing Nest
overload behavior. Implement before cosmetic logging refactors.

## WQ-020 — P2: apply record limits before reading values

**Locations:** `src/logger.ts`, `safeFields`, `sanitizeRecord`, `sanitizeValue`;
`test/logger.test.ts`.

Current `Object.entries(value).slice(0, MAX_SANITIZE_ENTRIES)` reads and allocates
every entry before discarding all but 100. `safeFields` also materializes all
top-level entries before filtering. A controlled object with 105 enumerable
getters nested in a log field executed all 105 getters in the source probe.
Thus the cap bounds emitted entries, not value inspection. Secret-valued
properties are read before the key's secret-name check as well.

Use selected own keys and descriptor/value handling only for admitted entries;
check reserved/secret names before reading values. Prefer non-invoking
accessor markers for unknown log objects, with explicit tests for compatibility.
Do not claim Object.keys itself has constant allocation or that proxy ownKeys
is cancellable. Keep depth and per-container limits, and add one shared
traversal-entry budget so bounded breadth at each level cannot multiply into
an enormous record. Document the chosen total bound and marker semantics;
retain normal useful fields and the current secret-name policy.

Tests: getter beyond the accepted limit never invoked, secret getter never
invoked, property access failure produces a safe marker, exact-limit behavior,
wide/deep trees, cycles and repeated references, arrays, and reserved fields.
Acceptance: bounded visited/output entries and no secret regression. No new
logging dependency. Combine with WQ-018 at the same normalization seam only
after separate regression cases make both contracts reviewable.

## WQ-021 — P2: make observability test claims and cleanup precise

1. Split `test/operations-assets.test.ts` into named tests for dashboard
   structure, alert/runbook linkage, emitted/referenced metric inventory,
   provisioning and label constraints. Share a small read-only asset fixture;
   retain independent allowed metric names. Rename text checks accurately and
   link semantic PromQL/collector validation to infrastructure gates rather
   than claiming substrings prove executable semantics.
2. In the real-provider test in `test/queue-tracing.test.ts`, use try/finally
   with provider shutdown. In HTTP and non-HTTP tests, cleanup must attempt
   every instrumentation/provider/Reflect restoration even when earlier cleanup
   rejects. Begin protection before patching globals. Keep owners local to
   their test; do not introduce a repository-wide cleanup framework.
3. Organize the large HTTP case into named request scenarios plus a shared
   sanitized-export assertion. Keep the actual configured instrumentation,
   in-memory exporter and loopback request proof; do not replace it with
   mocks of the sanitizer. Preserve malformed URL and custom lookup cases.
4. In `test/transport-metrics.test.ts`, inject the recording harness for each
   invalid measurement and assert all instrument collections remain empty.
   Include cases where an earlier field is valid and a later field is invalid
   to prove validation precedes any partial write.

Run the full package suite and relevant API/worker logging-adapter tests after
implementation. Lifecycle ownership stays in PF-03; this package review does
not reopen that decision or represent external collector qualification.
