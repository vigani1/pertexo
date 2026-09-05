# `@pertexo/observability` implementation and architecture audit

## Review identity and conclusion

- **Audited commit:** `7e4b37840a2b86c591046e16f1de834e8da2db79`
- **Audited tree:** `8481ebf86f4b36ff70687f86a2bb7933a00d65b8`
- **Production scope:** all 10 source files and all 1,304 physical source
  lines.
- **Test scope:** all 10 package test files and all 1,309 physical test lines,
  direct API/worker/maintenance consumers, the seven local observability assets,
  the alert runbook, package scripts, and relevant GitHub Actions jobs.
- **Architecture sources:** the authoritative backend plan, ADR-001, ADR-005,
  ADR-015, and the Phase 0C evidence in the implementation progress record.
- **Audit status:** reconciled against the current implementation on 2026-06-18.
- **Implementation status:** every repository-actionable finding is fixed and
  enforced. OBS-006 remains external production evidence, not unfinished local
  implementation.

The package is necessary and its high-level shape is good. It gives six process
roles one small configuration/logging/telemetry interface, keeps OpenTelemetry
and Pino out of domain packages, prevents browser imports, centralizes bounded
metric vocabularies, and provides useful injection seams. The 412-line
transport metric factory is intentional cohesive setup, not a reason to split a
file mechanically.

The original audit identified nine repository changes and one production-only
obligation. The repository changes have since landed and are verified below.
The local collector deliberately keeps its debug trace exporter; production
launch still requires evidence that the deployed OTLP destination retains and
serves traces under the documented operational policy.

## Current remediation record

| ID | Final status | Implementation and verification evidence |
| --- | --- | --- |
| OBS-001 | Fixed | `5dc09c3`; bounded secret-key classification and positive/negative hostile-input tests in `logger.test.ts`. |
| OBS-002 | Fixed | `5dc09c3`; fail-safe selection/property access, hostile proxy/getter/error tests, and constant unserializable marker. |
| OBS-003 | Fixed | `5c639d8`; bounded Nest call-shape parser and coverage of every level plus message, stack, context, object, secret, oversized, and adversarial multiline inputs. Stack recognition uses a bounded linear parser rather than a polynomial regular expression over library-controlled text. |
| OBS-004 | Fixed; continuous gate | `ae377ca`; `pnpm observability:check` structurally parses YAML/JSON and runs pinned Prometheus and collector validators in protected CI. |
| OBS-005 | Fixed; continuous gate | `19ae523`; package thresholds and root risk coverage are enforced. Fresh coverage after the bounded Nest parser: 90.27% statements (297/329), 88.20% branches (187/212), 90.32% functions (84/93), and 91.79% lines (291/317). |
| OBS-006 | External production evidence required | Repository configuration is complete, but no local test can prove the production backend owner, retention/access policy, deployed sampling/redaction, or retrieval of a real API-to-worker trace. |
| OBS-007 | Fixed | `5dc09c3`; execution-storage observation is required and all worker substitutes implement it. |
| OBS-008 | Fixed | `5dc09c3`; both maintenance histograms reject negative and non-finite durations and accept zero/positive values. |
| OBS-009 | Fixed | `bf62f10`; the supported eight-adapter set is explicitly constructed, dependency-pinned, and asserted. |
| OBS-010 | Fixed | `5dc09c3`; delay values must be non-negative safe integers within the Node timer limit, with invalid-boundary tests. |

Fresh verification on 2026-09-05 passed 10 files / 54 tests, package
typecheck, build, ESLint, package coverage, structural observability validation,
Prometheus configuration validation, all 24 alert rules, and OpenTelemetry
Collector validation. OBS-004 and OBS-005 are continuous safeguards: future
changes must preserve the protected CI commands and thresholds.

### Granular certification record

The package was recertified under the stricter component-audit contract after
the initial audit. The reviewer read the complete contents of all 24 tracked
package files: 10 production files, 10 test files, `package.json`, both
TypeScript configurations, and the Vitest configuration. The pass inspected
every export, internal sanitizer and validation helper, class method, lifecycle
branch, metric recorder, injected callback, test harness, and test case. It also
rechecked the server-only export map and the package's direct process-role
consumers. Automated inventories supported, but did not replace, the content
review.

Fresh recertification checks passed: typecheck, all 41 tests, build, and package
ESLint. No additional finding was discovered. OBS-001 through OBS-010 remain
the complete known finding set for the pinned implementation. Certification
describes review coverage, not implementation completion; the confirmed logger
defects and other open findings below remain actionable.

## Evidence collected

The review used full-file reading, exported/internal-callable inventory,
repository-wide symbol/import searches, direct-consumer tracing, plan/ADR
comparison, TypeScript compilation, package build, ESLint, all package tests,
an ad hoc V8 coverage run, direct logger reproductions, runtime instrumentation
enumeration, and semantic validation with the pinned Prometheus and
OpenTelemetry Collector images.

| Check | Result |
| --- | --- |
| `pnpm --filter @pertexo/observability typecheck` | Passed |
| `pnpm --filter @pertexo/observability test` | 10 files and 41 tests passed |
| `pnpm --filter @pertexo/observability build` | Passed |
| `pnpm exec eslint packages/observability` | Passed |
| Ad hoc package V8 coverage | 89.20% statements, 83.54% branches, 83.33% functions, 89.70% lines |
| Pinned Prometheus `promtool check rules` | Passed; 24 rules found |
| Pinned collector `validate` | Passed |
| Default instrumentation enumeration | 40 instrumentation instances constructed |
| Secret-key reproduction | `privateKey`, `xApiKey`, and `authToken` were emitted unchanged |
| Hostile-field reproduction | both a throwing `ownKeys` proxy and a throwing enumerable getter escaped the logger |

Coverage is not an enforced package threshold. File measurements were:

| Source | Statements | Branches | Functions |
| --- | ---: | ---: | ---: |
| `config.ts` | 100.00% | 100.00% | 100.00% |
| `logger.ts` | 87.50% | 82.95% | 85.71% |
| `maintenance-metrics.ts` | 100.00% | 100.00% | 100.00% |
| `nest-runtime.ts` | 64.29% | 37.50% | 61.54% |
| `queue-tracing.ts` | 83.33% | 63.64% | 50.00% |
| `runtime.ts` | 87.50% | 50.00% | 100.00% |
| `server-only.ts` | 50.00% | 50.00% | 100.00% |
| `telemetry.ts` | 81.82% | 100.00% | 80.00% |
| `transport-metrics.ts` | 100.00% | 100.00% | 100.00% |

The uncovered `server-only.ts` failure is environment-impossible in the Node
test process and does not justify browser emulation merely for a percentage.

## Architecture and ownership

### Module shape and dependency direction

The package owns five related capabilities:

1. immutable observability configuration;
2. structured, correlated, redacted process logging;
3. OpenTelemetry SDK construction and lifecycle;
4. common queue/maintenance metric and tracing adapters; and
5. thin Nest lifecycle/logger integration.

This is one cohesive cross-cutting module rather than a generic utility dump.
Its public interfaces hide Pino configuration, sanitization, OpenTelemetry SDK
construction, metric instruments, trace extraction, and Nest provider wiring.
That depth gives the package leverage across API, worker, retention, recovery,
lifecycle-command, and operator-command without making those applications
depend directly on SDK implementation details.

Production imports point inward. The package depends only on Pino,
OpenTelemetry, Zod, and Node process state; it imports no application, database,
queue, workflow, or provider module. There is no internal cycle. Queue-job
vocabulary is repeated as a finite observability type to avoid an
observability-to-queue dependency; the worker's exhaustive `satisfies
Record<JobName, TransportJob>` mapping makes drift fail at compile time. That is
a reasonable seam, not accidental duplication.

### Fit with the plan and ADRs

The module complies with the plan's TypeScript, structured-log,
OpenTelemetry, Prometheus-style metric, fixed-cardinality, trace propagation,
server-only, and graceful-shutdown direction. API and worker start telemetry
before dynamically importing instrumented frameworks. Queue context is carried
through the plan-authorized bounded `traceparent` field. IDs stay out of metric
labels while traces/logs may carry correlation identifiers.

ADR-001's modular-monolith direction is preserved, and ADR-005's durable
transport metrics have concrete outbox, queue, handler, stall, drain, and
process-start instruments. ADR-015's API and regional-recovery signals are
represented in repository dashboards and alerts. The remaining operational
question is whether production has a persistent trace backend; the local
collector sends traces only to its debug exporter (OBS-006).

## Public interface assessment

The package uses explicit subpaths for configuration, logging, telemetry,
transport metrics, queue tracing, runtime delay, and Nest integration. Every
runtime target is mapped to `false` in the browser field and imports the Node
guard directly or through an owning module. The package-contract test walks all
exports, so adding an unguarded browser path fails.

The root barrel is small and intentional. Transport metrics and Nest runtime
remain deep exports, reducing accidental browser/general-domain imports. Types
are mostly precise discriminated unions; no `any`, unsafe assertion, default
export, or framework type leaks into the core interface. `LogEventName = string`
is appropriately paired with runtime validation because compile-time literals
cannot protect JavaScript or dynamically composed callers.

The public-interface weaknesses are narrow:

- `observeExecutionStorage` is optional although the only production factory
  always implements it, moving compatibility burden onto every caller
  (OBS-007);
- maintenance metric durations accept any number while transport durations are
  fail-fast validated (OBS-008); and
- the shared delay accepts invalid numbers that Node silently coerces
  (OBS-010).

## Complete production-code review

### `src/config.ts`

`httpEndpointSchema` restricts the exporter to HTTP(S), and the strict Zod
object rejects undeclared keys. `parseObservabilityConfig` trims required
identity fields, requires headers to have an endpoint, copies headers, and
freezes both nested and outer values. The function is short, readable, and
truthfully owns parsing an untrusted input. Its separate input/output types
correctly express Zod defaults.

Allowing URL userinfo is not currently a finding: OTLP deployments may use it,
and callers have a dedicated headers channel. The operational preference should
remain header-based authentication, with secret configuration never logged.

### `src/logger.ts`

The implementation keeps the difficult security logic local. URL-userinfo and
free-text redaction are bounded before regex work; object depth, collection
width, string size, circular graphs, error causes, and stacks are bounded;
reserved service/correlation keys cannot be overwritten; invalid event names
become one constant event; and Pino applies a second path-redaction pass.
`correlationFields` accepts only valid active span contexts.

The small character-scanning helpers are preferable to a permissive URL parse
because log strings can contain URLs embedded in arbitrary text. The repeated
six logging methods are the conventional `StructuredLogger` interface and
delegate to one implementation; replacing them with a dynamic method or class
hierarchy would reduce type clarity without useful leverage.

Two real weaknesses remain. Secret-name matching is an exact normalized
allowlist. Common variants not in that set are not redacted (OBS-001). Also,
`safeFields` calls `Object.entries(fields)` before entering the guarded
sanitizer; getters and proxy traps can therefore throw from logging itself
(OBS-002). `sanitizeError` similarly assumes its `message`, `stack`, and `cause`
properties are safe to read, which should be included in the same hardening.

### `src/maintenance-metrics.ts`

The factory creates four fixed-name, fixed-label instruments and returns only
the two operations maintenance callers need. The interface is deep and small.
Command/outcome unions prevent normal TypeScript callers from creating
high-cardinality labels. The one inconsistency is the absence of finite,
non-negative duration validation despite that protection existing in transport
metrics (OBS-008).

### `src/nest-runtime.ts`

`NestLoggerAdapter` isolates Nest's variadic logger shape and prevents arbitrary
message payloads from becoming structured fields. `TelemetryShutdown` correctly
adapts the SDK lifecycle to Nest's shutdown hook. The registration factory
centralizes identical provider construction used by API and worker without
making the package import Nest itself; its structural return type is a useful
low-coupling seam.

The privacy posture is conservative but too lossy. Except for an actual
`Error`, message content is discarded, and a final optional string is assumed
to be context. Many framework/bootstrap failures arrive as strings plus a stack
or context, so the resulting `nest.error` record may contain no safe explanation
and may misclassify a stack as context (OBS-003). This is an interface-quality
problem rather than an argument for forwarding raw framework messages.

### `src/queue-tracing.ts`

`createQueueTraceRunner` has one clear responsibility: activate a consumer span
under either the validated remote parent or current context, attach bounded
semantic attributes, preserve the operation's return/error identity, record
failure, and always end the span. The injected tracer, propagator, and active
context are appropriate test seams. A class would add no stateful value.

Only `traceparent` is extracted. That exactly matches the queue contract and
authoritative plan; adding baggage or arbitrary trace state would increase job
surface and is not presently required. Runtime input validation belongs to the
queue Zod contract, not this already-internal runner.

### `src/runtime.ts`

`waitForAbortableDelay` correctly closes the abort-registration race, clears
its timer, removes its listener, and resolves for both elapsed time and
supervisor cancellation. The worker's similarly named helper has deliberately
different semantics: work cancellation rejects, while this shared maintenance
loop delay treats cancellation as loop wake-up. That is semantic reuse, not an
exact duplicate suitable for forced consolidation. Invalid delay values are
silently coerced by `setTimeout`, however (OBS-010).

### `src/telemetry.ts`

`signalEndpoint`, `createOpenTelemetrySdk`, and the two lifecycle classes form a
cohesive SDK adapter. Configuration is copied, standard resource attributes are
attached, traces and metrics use separate OTLP paths, export intervals/timeouts
are bounded, disabled mode creates no SDK, startup is idempotent, shutdown is
memoized, and restart after shutdown fails explicitly.

The startup order in every process entrypoint is correct: lifecycle creation
and `start()` occur before dynamic imports of Pino/Nest/application modules.
There is no hidden process-global start on import.

`createNodeAutoInstrumentations` configures host and runtime metrics, but it
does not mean “only” those two instrumentations. At the pinned dependency with
the enabling environment variable unset, the function constructed 40 adapters,
including HTTP, Nest, Pino, PostgreSQL, ioredis, many unused frameworks and
clients, plus the two runtime metric adapters. This broad default may be
intentional, but it is implicit, dependency-heavy, and incorrectly described by
the current test (OBS-009).

### `src/transport-metrics.ts`

The long factory is justified setup with a low-branch, high-locality shape. All
18 metric names, their instruments, units, descriptions, validation, and
recording methods are easiest to compare when colocated. Splitting one file per
instrument would enlarge the interface and scatter one schema.

The discriminated job/outcome types prevent invalid queue/job combinations and
error labels in TypeScript. Numeric observations are checked before reaching
OpenTelemetry. Attributes use finite job, queue, status, surface, lifecycle,
outcome, and error vocabularies; workspace, run, attempt, artifact, and event IDs
never become metric labels. The worker exhaustively maps authoritative queue
names to this interface and rejects an invalid observed pairing.

`observeExecutionStorage` being optional is stale compatibility residue rather
than a meaningful alternate implementation: the production factory always has
it and the sole caller uses optional chaining only to accommodate older test
fixtures (OBS-007). Other enum values rely on TypeScript rather than duplicating
runtime Zod parsing, which is acceptable because all production values come
from validated internal records.

### `src/index.ts` and `src/server-only.ts`

The explicit barrel preserves discoverability without wildcard ambiguity. The
runtime Node guard is intentionally tiny, and every export-map runtime target is
browser-disabled. `.js` specifiers in `.ts` files are correct NodeNext ESM, not
mixed-language implementation.

## Reuse, readability, and code cleanliness

- Every production file has a coherent owner; no file is large because it mixes
  unrelated domains.
- No dead callable, unused production export, dependency cycle, unsafe `any`,
  ignored promise, mutable singleton, or speculative class hierarchy was found.
- Factories expose small capability interfaces and accept narrow injection
  seams. Their implementations hide substantially more complexity than callers
  need to understand.
- Logger helpers are cohesive security internals and should remain private.
- The transport metric factory should not be split merely to lower its line
  count. Its one source of truth has higher locality than a directory of tiny
  wrappers.
- API and worker retain two thin application-owned Nest modules. The repository
  duplication baseline documents why merging those roots would blur deployment
  ownership; the reusable registration algorithm already lives here.
- The worker and shared delay helpers look similar but encode reject-on-abort
  versus resolve-on-abort contracts. Their common mechanism could be shared only
  if naming makes those semantics impossible to confuse; consolidation is not
  currently necessary.
- Metric construction repeats normal OpenTelemetry ceremony, but the varying
  names, units, instrument kinds, labels, and validation are declarative domain
  facts. A generic metric-builder abstraction would hide review-critical
  differences for little deletion value.

## Direct-consumer and integration assessment

API and worker use the same configuration parser, structured logger, telemetry
lifecycle, Nest adapter, and registration factory. Worker additionally consumes
queue tracing and transport metrics. Retention and lifecycle-command use the
abortable supervisor delay. Lifecycle-command and recovery use maintenance
metrics. Operator-command shares logger and telemetry lifecycle. Every direct
workspace consumer declares the package dependency.

The integration order preserves auto-instrumentation: process entrypoints import
only the telemetry subpath, start it, then dynamically import logging and the
application. Shutdown paths invoke telemetry after bounded application cleanup.
Queue consumers activate the runner around the actual handler. Metric job
vocabulary is joined to the authoritative queue map exhaustively inside worker,
so new queue jobs force a compile-time decision.

The local operations stack receives both OTLP signals and exposes Prometheus
metrics. It does not retain/query traces; its trace pipeline uses the collector
debug exporter. Repository-owned ECS manifests require an OTLP endpoint but do
not record the external backend's trace-retention/query contract (OBS-006).

## Test usefulness and CI assessment

### Package tests

The 41 tests are useful and mostly behavioral:

- `config.test.ts` proves defaults, freezing, strict rejection, protocol bounds,
  endpoint/header coupling, and explicit exporter configuration.
- `logger.test.ts` captures real Pino JSON and proves reserved fields, invalid
  event handling, nested redaction, error cause/stack retention and redaction,
  adversarial text bounds, and active-span correlation.
- `maintenance-metrics.test.ts` verifies emitted names and finite dimensions,
  but not invalid numeric behavior.
- `nest-runtime.test.ts` verifies conservative adaptation, registration, and
  shutdown delegation, but exercises only `error`; five adapter methods and
  important variadic Nest call shapes remain uncovered.
- `queue-tracing.test.ts` proves remote extraction, current-parent fallback,
  fixed semantic attributes, success/failure status, exception identity, and
  span finalization. It does not directly exercise the carrier getter or a
  non-`Error` rejection.
- `runtime.test.ts` proves elapsed and abort wake-up paths.
- `telemetry.test.ts` proves configuration of two runtime metric adapters and
  lifecycle state transitions. It never constructs the real SDK or asserts the
  effective auto-instrumentation set or signal URLs.
- `transport-metrics.test.ts` is strong: every instrument-writing method and all
  numeric validation helpers reach 100% measured coverage, and dynamic-ID
  labels are explicitly excluded.
- `package-contract.test.ts` checks every export's server-only mapping.
- `operations-assets.test.ts` cross-links 24 alerts/runbooks, 21 dashboard
  panels, allowed Prometheus series, emitter source names, collector processors,
  and provisioning paths. It is a valuable drift detector, but substring checks
  do not parse PromQL or collector YAML semantically (OBS-004).

### CI

GitHub Actions builds, lints, typechecks, and executes all 41 tests in the core
unit matrix. Deployment-security renders both Compose files. Root coverage
enforces workflow-engine, database, worker, and API only; observability is not a
critical cohort (OBS-005).

CI does not run `promtool check rules` or the collector's `validate` command.
Those exact commands pass on the audited tree using the already-pinned images,
but a future invalid expression or processor key can still pass the current
string and Compose checks (OBS-004). CI also does not start the observability
stack or send an end-to-end signal through collector-to-Prometheus; current
Phase 0C evidence is a historical OTLP capture smoke, not a recurring gate.

## Findings and required changes

### OBS-001 — Common secret field names bypass structured-log redaction

- **Severity:** P1.
- **Classification:** confirmed defect.
- **Status:** fixed in `5dc09c3`.
- **Evidence:** `packages/observability/src/logger.ts:47-64,185-188` uses an
  exact normalized-name set. Direct logging of `privateKey`, `xApiKey`, and
  `authToken` emitted each supplied value unchanged. Existing tests cover only
  members of the current allowlist.
- **Impact:** one accidental structured field from a credential/provider object
  can write authentication or signing material to process logs despite the
  module's advertised redaction defense. Provider seams should still avoid
  passing secrets, but logger serialization is the plan's second safety layer.
- **Required change:** define and document a tested secret-key classification
  policy that covers common key/token/private/signing variants and sensitive
  header spellings without relying on a short exact set. Preserve bounded work;
  do not use an unbounded or catastrophically backtracking expression.
- **Required verification:** table-drive positive variants, separators/casing,
  nested objects, arrays, errors/causes, and negative names such as `tokenCount`
  that should remain visible. Keep an adversarial runtime/size bound.

### OBS-002 — Hostile field objects can make logging throw into business code

- **Severity:** P1.
- **Classification:** confirmed defect.
- **Status:** fixed in `5dc09c3`.
- **Evidence:** `logger.ts:265-274` performs the first `Object.entries(fields)`
  outside `sanitizeRecord`'s try/catch. A proxy whose `ownKeys` throws and an
  object with a throwing enumerable getter both caused `logger.info` to throw in
  direct reproductions. Error property reads at lines 201-209 are similarly
  assumed safe.
- **Impact:** logging an unexpected library/provider object can replace or mask
  the original business failure and can interrupt cleanup/error handling.
- **Required change:** make selection and property access fail-safe as one
  bounded sanitizer operation. On unreadable input, emit a constant
  `[Unserializable]` marker or omit fields while still writing the event. Apply
  the same protection to unusual `Error` properties.
- **Required verification:** throwing `ownKeys`, descriptor/getter, error
  `cause`/`stack`, circular proxy, null-prototype, symbol, array, and normal
  object cases; assert that logging never throws and never emits trap text.

### OBS-003 — Nest log adaptation loses actionable non-`Error` diagnostics

- **Severity:** P2.
- **Classification:** maintainability and operations improvement.
- **Status:** fixed in `5c639d8`.
- **Evidence:** `nest-runtime.ts:6-44` records only `messageType` and the last
  optional string. String messages are discarded; a single stack string can be
  mislabeled as `context`. Tests assert the privacy behavior for one actual
  `Error` call but do not characterize common Nest string/stack/context shapes.
- **Impact:** framework bootstrap, routing, DI, and lifecycle failures may all
  appear as indistinguishable `nest.error` events with no safe diagnostic, making
  incident response depend on reproduction rather than logs.
- **Required change:** normalize documented Nest call shapes into bounded,
  redacted safe summary, context, and error fields. Preserve fixed event names
  and never forward raw arbitrary payloads. Prefer a small private parser over
  exposing Nest-specific complexity to consumers.
- **Required verification:** every logger level plus string message, `Error`,
  message/stack, message/context, message/stack/context, object payload, secret
  content, and oversized content cases.

### OBS-004 — CI does not semantically validate alert or collector configuration

- **Severity:** P2.
- **Classification:** continuous-control gap.
- **Status:** fixed in `ae377ca`; retained as a continuous CI safeguard.
- **Evidence:** `operations-assets.test.ts` uses JSON parsing and substring
  assertions. The deployment-security job runs `docker compose ... config`,
  which validates the Compose document but not mounted Prometheus rules or
  collector configuration. The runbook mentions `promtool`, but CI does not run
  it. Both real validators pass for the audited tree.
- **Impact:** malformed PromQL/YAML or an unsupported collector component can
  merge while all mandatory checks are green, disabling the exact alerts or
  signal pipeline intended to report production failure.
- **Required change:** use the pinned Prometheus image to run `promtool check
  rules` and the pinned collector image to run `validate` in CI. Also validate
  Prometheus configuration and Grafana dashboard/provisioning through a bounded
  machine check; retain fast cross-link tests for repository semantics.
- **Required verification:** deliberately invalid rule syntax and collector
  component names must fail the gate; current assets remain green.

### OBS-005 — The shared observability package has no enforced coverage baseline

- **Severity:** P2.
- **Classification:** continuous-control gap.
- **Status:** fixed in `19ae523`; retained as a continuous coverage safeguard.
- **Evidence:** `package.json` has no `test:coverage`; root `test:coverage`
  includes workflow-engine, database, worker, and API only. Ad hoc package branch
  and function coverage are 83.54% and 83.33%, with Nest integration at 37.50%
  branch coverage.
- **Impact:** logger hardening, lifecycle, trace failure, or framework adapter
  paths can regress while all mandatory coverage checks pass.
- **Required change:** after OBS-001 through OBS-003 tests land, add justified
  per-package thresholds and include the package in root coverage/risk review.
  Explicitly review environment-impossible branches instead of fabricating
  tests.
- **Required verification:** demonstrate a threshold regression fails locally
  and in CI; keep the repository risk report green.

### OBS-006 — Persistent production trace storage/querying is an external assumption

- **Severity:** P2 until deployment evidence proves it; P1 for production launch
  if no trace backend exists.
- **Classification:** unverified production assumption.
- **Status:** external production evidence required; no repository-only action
  can close the deployed retrieval and retention obligation.
- **Evidence:** `otel-collector.yaml` sends metrics to Prometheus but traces only
  to the `debug` exporter. ECS workload declarations require an OTLP endpoint
  without recording a repository-verifiable retention/query backend. The plan
  requires operational OpenTelemetry traces, and Phase 0C proves transport to a
  capture server rather than retained production querying.
- **Impact:** trace/span IDs may appear in logs, but operators cannot retrieve a
  distributed trace after an incident if the configured external endpoint does
  not retain it.
- **Required change:** keep the local debug-only stack if that is deliberate,
  but document the production collector/backend owner, retention, access,
  sampling, sensitive-attribute policy, and trace-to-log workflow. Add external
  deployment evidence or a repository-managed trace backend before launch.
- **Required verification:** send one API-to-outbox-to-worker trace in the
  deployed environment, retrieve it by trace ID, verify parentage/redaction and
  retention, and retain drill evidence.

### OBS-007 — Optional execution-storage metrics preserve no real alternate contract

- **Severity:** P3.
- **Classification:** maintainability improvement.
- **Status:** fixed in `5dc09c3`.
- **Evidence:** `transport-metrics.ts:142-158` makes
  `observeExecutionStorage` optional, while `createTransportMetrics` always
  implements it. The sole production caller uses optional chaining; several
  test fixtures omit the method.
- **Impact:** a required plan metric can silently disappear from a substitute,
  and production code carries compatibility uncertainty solely to reduce fixture
  updates.
- **Required change:** make the capability required and update structural test
  fixtures, or split artifact/capacity metrics into an explicit separate
  capability if absence is genuinely supported. Do not leave requirement status
  encoded as optional chaining.
- **Required verification:** typecheck should fail for an incomplete required
  substitute; worker capacity tests prove both artifact and execution-storage
  observations.

### OBS-008 — Maintenance metric durations accept invalid measurements

- **Severity:** P3.
- **Classification:** maintainability improvement.
- **Status:** fixed in `5dc09c3`.
- **Evidence:** `maintenance-metrics.ts:48-68` records any duration, unlike the
  shared validation used by transport histograms. Current application callers
  derive values from `performance.now()` and are safe, but the exported
  capability does not enforce its own invariant.
- **Impact:** a future or untyped caller can emit negative, infinite, or NaN
  histogram values and corrupt queries without an immediate local failure.
- **Required change:** reuse a small internal finite/non-negative measurement
  guard (without creating a public generic utility) and apply it before either
  maintenance histogram write.
- **Required verification:** negative, NaN, infinities, zero, and valid positive
  durations for both methods.

### OBS-009 — Auto-instrumentation breadth is implicit and inaccurately tested

- **Severity:** P2.
- **Classification:** maintainability, dependency, and performance improvement.
- **Status:** fixed in `bf62f10`.
- **Evidence:** `telemetry.ts:34-46` passes explicit config for two adapters to
  `getNodeAutoInstrumentations`, but the pinned library enables all other
  default adapters. With relevant environment variables unset, the direct
  enumeration constructed 40 instrumentation instances. The test title says it
  “enables only process host metrics and configures runtime monitoring” while
  asserting only the input object passed to a mock factory.
- **Impact:** startup work, monkey-patching behavior, transitive dependency and
  supply-chain surface, and emitted span behavior change with the meta-package
  version or undeclared OpenTelemetry environment variables. Reviewers can
  incorrectly infer a two-adapter policy.
- **Required change:** explicitly choose the supported auto-instrumentation set
  for this stack (at minimum evaluate HTTP/undici, Nest, Pino, PostgreSQL,
  ioredis, host, and runtime) and either configure the meta-package fail-closed
  to that set or depend on selected instrumentation packages directly. If broad
  defaults are retained, document and test that policy honestly and govern the
  environment variables in deployment configuration.
- **Required verification:** assert effective instrumentation names under clean
  and deployment-supported environment settings; measure startup/dependency
  impact and prove required API/database/Redis spans still appear.

### OBS-010 — Shared delay accepts silently coerced durations

- **Severity:** P3.
- **Classification:** maintainability improvement.
- **Status:** fixed in `5dc09c3`.
- **Evidence:** `runtime.ts:1-15` forwards any number to `setTimeout`. Negative,
  NaN, infinite, fractional, or excessive values have host-dependent/coerced
  behavior. Current app configuration schemas validate their intervals first.
- **Impact:** the exported helper's interface is broader than its actual useful
  contract and can create a tight maintenance loop if reused incorrectly.
- **Required change:** require a finite non-negative safe integer within the
  platform's maximum timer bound, or accept a validated branded/config-owned
  value if such a type already exists. Keep the helper otherwise unchanged.
- **Required verification:** valid zero/positive delay, invalid numeric matrix,
  elapsed cleanup, already-aborted signal, and abort-race cases.

## Non-findings and rejected refactors

- The package is not an unnecessary monorepo layer. Six applications use its
  concrete adapters, and duplicating logging/telemetry setup would create
  security and lifecycle drift.
- The 378-line logger is cohesive security code. Splitting each private helper
  into files would expand navigation without creating independent ownership.
- The 412-line transport metrics file is a single reviewable metric schema with
  low control-flow complexity. It should remain colocated unless distinct teams
  or lifecycles emerge.
- Pino and OpenTelemetry are appropriate established adapters; replacing them
  with home-grown serialization or telemetry would be worse.
- Zod is justified at the configuration seam; internal metric calls do not need
  schema parsing on every hot-path measurement.
- Freezing returned configuration/capability objects protects process-global
  shared state at negligible frequency/cost.
- Only carrying `traceparent` is compliant with the versioned bounded queue
  contract. Adding arbitrary baggage is not required.
- Source-level metric-name cross-link tests remain valuable even after real
  config validators are added; they enforce repository-specific cardinality and
  runbook rules those tools do not know.
- `.js` imports in TypeScript are correct ESM output references.

## Recommended repair order

1. Fix and characterize logger secrecy/resilience under OBS-001 and OBS-002.
2. Improve Nest diagnostic normalization under OBS-003 without weakening
   redaction.
3. Add real operations validators to CI under OBS-004.
4. Decide and pin the effective instrumentation policy under OBS-009.
5. Enforce package coverage under OBS-005 after the new branches are tested.
6. Close or explicitly gate the production trace-backend assumption in
   OBS-006.
7. Tighten the smaller interface invariants in OBS-007, OBS-008, and OBS-010.

Re-audit the changed tree and run one end-to-end OTLP-to-Prometheus and retained
trace smoke before treating the observability capability as production-complete.
