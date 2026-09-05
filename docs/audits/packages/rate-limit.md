# `@pertexo/rate-limit` implementation and architecture audit

## Review identity and conclusion

- **Audited commit:** `7e4b37840a2b86c591046e16f1de834e8da2db79`
- **Audited tree:** `8481ebf86f4b36ff70687f86a2bb7933a00d65b8`
- **Production scope:** all 4 source files and all 403 physical source lines.
- **Test scope:** all 3 package test files and all 270 physical test lines, plus
  the API's real-Redis integration suite, API interceptor/module/classification
  suites, worker composition and provider-admission tests, package scripts, and
  CI jobs that execute them.
- **Architecture sources:** the authoritative backend plan and ADR-012.
- **Audit status:** granularly certified for the pinned implementation tree.
- **Implementation status:** seven repository-controlled findings are fixed.
  RL-002 remains an external deployment-evidence obligation: V1 requires a
  non-clustered replicated Redis primary, and the selected production topology
  must be observed before deployment readiness can be claimed.

The package has a good core design: it is cohesive, has no dependency cycle,
keeps the policy vocabulary in one place, hashes subject identifiers, and uses
one atomic Lua operation across all applicable dimensions. Its production
surface is readable and materially deeper than its small public interface. The
production runtime now recovers after a post-connect disconnect, is exercised
against real Redis, and has package-owned coverage thresholds. Production
evidence remains incomplete until the deployed Redis topology is confirmed
compatible with the atomic multi-key script.

The audit does not recommend splitting these files. No function is difficult
because of size, no repeated production algorithm warrants extraction, and no
dead production abstraction was found. The necessary work is behavioral and
verification-focused.

### Granular certification record

This package was recertified under the stricter component-audit contract after
the initial audit. The reviewer read the complete contents of all 11 tracked
package files: 4 production files, 3 test files, `package.json`, both TypeScript
configurations, and the Vitest configuration. The pass inspected every exported
symbol and every internal callable, constructor, closure, test fake, fixture
helper, and test case; it also retraced all repository imports and direct API
and worker consumers. Automated search and test evidence were used to verify the
manual reading rather than as a replacement for it.

No additional finding was discovered in this recertification. RL-001 through
RL-008 remain the complete known finding set for the pinned implementation.
“Complete” here describes the review coverage, not the implementation status:
the current disposition and remediation evidence are recorded below.

## Evidence collected

The review used full-file reading, repository-wide symbol/import searches,
direct-consumer tracing, plan/ADR comparison, TypeScript compilation, package
build, ESLint, all package tests, an ad hoc V8 coverage run, and a direct runtime
state-transition reproduction.

| Check | Result |
| --- | --- |
| `pnpm --filter @pertexo/rate-limit typecheck` | Passed |
| `pnpm --filter @pertexo/rate-limit test` | 3 files and 29 tests passed |
| `pnpm --filter @pertexo/rate-limit build` | Passed |
| `pnpm exec eslint packages/rate-limit` | Passed |
| Enforced package V8 coverage | 95.04% statements, 91.42% branches, 92.3% functions, 95.69% lines |
| Real-Redis suite inspection | The service-backed CI job instantiates `RedisRateLimitRuntime`, kills its production client connection, and proves bounded recovery |
| Lifecycle regression | Concurrent connect deduplication, initial rejection recovery, post-ready reconnect, close-after-connect, and close-during-connect all pass |

The coverage figures are enforced by the package-owned configuration and root
`test:coverage` command rather than recorded as an ad hoc measurement.

## Architecture and ownership

### Module shape

The package owns four coherent responsibilities:

1. `policy.ts` owns the finite endpoint/dimension vocabulary and translates an
   authoritative subject into an immutable decision.
2. `distributed-rate-limiter.ts` owns Redis key derivation, atomic
   multi-dimension consumption, and response decoding.
3. `redis-runtime.ts` owns the concrete ioredis client, bounded operation time,
   connection lifecycle, and shutdown.
4. `index.ts` defines the package's only supported export path.

This is a sensible deep-module arrangement. API and worker code consume a small
`evaluate`, `consume`, and `close` interface while the package hides hashing,
Lua, Redis arguments, deadlines, and client settings. The
`RateLimitScriptExecutor` seam also makes the atomic algorithm independently
testable without importing application or NestJS code.

Dependency direction is correct: the package imports only Node crypto and
ioredis, and imports no application, database, queue, HTTP, or NestJS module.
Internal imports form a one-way graph from runtime to limiter to policy, with no
cycle. API and worker both depend inward on the package. This complies with the
modular-monolith shape in ADR-001 and does not pollute the execution engine.

### Policy and durability fit

The implementation follows ADR-012's separation between PostgreSQL-authoritative
business quota/admission and Redis-backed short-window abuse control. The Lua
script checks all dimensions before incrementing any, increments within one
Redis operation, assigns a fixed expiry, and never stores raw actor, workspace,
connection, origin, or address identifiers in keys. Caller-owned fail-open and
fail-closed behavior is represented in `RateLimitDecision` and applied at the
API seam. Provider execution checks the limit before secret resolution and
provider I/O.

The package intentionally does not persist durable workflow truth. Redis loss
therefore affects temporary admission/availability but cannot erase a run or
grant PostgreSQL business capacity. That architectural choice is correct.

### Public interface

The root export exposes three runtime classes, the endpoint-class constant, and
the types needed to compose or substitute them. The surface is understandable
and has no default export or unsupported subpath export. Some types currently
have no external named import, but they describe public method fields and are
reasonable consumer vocabulary; deleting them would save almost nothing and
would make typed adapters less ergonomic. No public export is currently harmful
enough to remove.

The main interface weakness is that `RateLimitDecision` is a freely constructible
structural type although `DistributedRateLimiter.consume` relies on numeric,
uniqueness, and non-empty invariants that TypeScript cannot express. That is
recorded as RL-003 rather than treated as a reason to add speculative wrapper
classes.

## Complete production-code review

### `src/policy.ts`

| Callable/value | Assessment |
| --- | --- |
| `RATE_LIMIT_ENDPOINT_CLASSES` | A useful finite vocabulary. The `as const` tuple and derived union prevent spelling drift. Runtime consumers do not yet use the tuple to exhaustively verify route policy behavior. |
| `RULES` | `Readonly<Record<...>>` gives compile-time completeness and keeps limits local. The values match ADR-012. The policy version embedded in Redis keys is not mechanically tied to changes here (RL-008). |
| `SUBJECT_LABELS` | Clear and finite. It improves error messages without introducing a needless helper layer. |
| `requiredSubject` | Small, readable normalization plus invariant check. Trimming at policy construction prevents whitespace-only bypass. It does not distinguish dimensions that ADR-012 describes as conditional “when scoped” (RL-004). |
| `AbuseRateLimitPolicy.evaluate` | Straight-line and readable. It returns new decision/dimension objects, so callers cannot mutate shared rule tables. A stateless function could be marginally smaller, but the class is a useful injectable policy seam in the API and is not overabstraction. Instantiating it per worker connection resolution is unnecessary but negligible. |

All endpoint limits and fail modes match ADR-012's table at the pinned tree. The
type-level record prevents an endpoint class from lacking a rule, but it does
not prove the numeric table or conditional-scope semantics; tests must do that.

### `src/distributed-rate-limiter.ts`

| Callable/value | Assessment |
| --- | --- |
| `RateLimitScriptExecutor.eval` | A narrow adapter seam that isolates the algorithm from ioredis and makes malformed replies testable. Its shape matches the single Redis command actually required. |
| `CONSUME_SCRIPT` | Cohesive intentional complexity. One Lua script is necessary for all-or-nothing multi-dimension evaluation. Splitting it would weaken locality. It uses integer Redis replies, checks every current count first, increments only on full admission, and applies expiry on first increment. |
| `counterKey` | Uses SHA-256 over endpoint class, dimension kind, and identifier with NUL separators. Raw subject identifiers never enter Redis keys. Its prefix is derived from the policy-owned counter-schema compatibility identity. |
| `parseScriptResult` | Validates tuple shape and integer elements before its single justified tuple assertion. There is no `any`, unchecked external cast, or silent allow path. |
| `DistributedRateLimiter.constructor` | Accepts its only dependency explicitly. This is testable and avoids hidden process-global Redis state. |
| `DistributedRateLimiter.consume` | Readable orchestration: validate endpoint, window, identifier, limit, and dimension uniqueness invariants; derive keys; make one operation; decode allow/reject; bound retry to 1–60 seconds; and return a finite dimension kind. |

The fixed-window algorithm can allow traffic on both sides of a wall-clock
window boundary; that is an inherent property of the explicitly chosen fixed
window, not an implementation defect. The code does not claim sliding-window
semantics.

The Lua operation uses multiple keys. Redis's
[multi-key operation documentation](https://redis.io/docs/latest/develop/using-commands/multi-key-operations/)
states that keys declared to a Lua script in an OSS-clustered deployment must
occupy one hash slot, while these independently hashed dimension keys generally
will not. That makes non-clustered Redis topology an architectural prerequisite
(RL-002).

### `src/redis-runtime.ts`

| Callable/value | Assessment |
| --- | --- |
| `RedisRateLimitRuntime.constructor` | Correctly owns one lazy client, disables the offline queue and automatic retry strategy, bounds ioredis connect/command settings, and installs an error listener so EventEmitter errors do not crash the process. Backend errors remain observable at caller decision metrics. |
| executor closure | Applies one end-to-end deadline around connect plus `EVAL`, which is better than unrelated per-step timers. It forwards only strings and the declared key count. |
| `consume` | A deliberately thin delegation; no redundant behavior or abstraction. |
| `close` | Chooses graceful `quit` only for a ready client and immediate disconnect otherwise, permanently preventing later reconnect. |
| `connect` | Deduplicates concurrent connects, clears settled attempts, reconnects a non-ready client, and rejects/disconnects when shutdown wins an in-flight connection race. |
| `withDeadline` | Owns and unreferences its timer, clears it in `finally`, disconnects on expiry, and treats a racing unknown Redis outcome conservatively. The timer does not cancel JavaScript work itself; disconnect is the correct available cancellation mechanism for this client. |
| `operationTimeout` | Applies a finite default and validates a safe 100–10,000 ms integer range, including upper, fractional, and non-finite rejection coverage. |

### `src/index.ts`

The barrel is explicit and readable. It has no wildcard exports, side effects,
or duplicate implementation. The `.js` specifiers are correct for TypeScript
`NodeNext` ESM output. Package metadata exposes only the compiled root and does
not accidentally publish source or test subpaths.

## Integration-seam review

### API

The Nest interceptor evaluates policy after its guards and before controller
work, prefers authorized workspace scope over route parameters, normalizes
origin/address inputs, reports bounded low-cardinality metrics, and implements
the ADR's per-class failure mode. Explicit route metadata and a startup-oriented
classification contract prevent silent unclassified routes. The dynamic module
owns shutdown when it owns the Redis runtime and accepts an injected consumer
for tests.

`RateLimitMetricRecorder` preserves `RateLimitDimensionKind` at the application
seam, preventing a future arbitrary high-cardinality label.

### Worker

Provider execution evaluates the shared `provider_execution` policy using the
workspace and connection before credential resolution and provider I/O. A
limited result becomes `ProviderExecutionRateLimitError`; backend rejection also
fails closed by preventing resolution. The worker owns and closes the runtime
when it creates it, and injected substitutes keep the seam testable.

The worker instantiates `AbuseRateLimitPolicy` inside each resolution. Because it
is stateless and tiny, this has no meaningful performance effect. Hoisting one
instance could improve expression of ownership but is not actionable technical
debt.

## Test and CI review

### Package tests

`distributed-rate-limiter.test.ts` proves one atomic invocation, secret-free
keys, argument ordering, the counter-schema identity, a capped rejection
result, fail-safe malformed reply handling, and invalid decision rejection for
empty/duplicate dimensions, blank identifiers, unsafe limits, and invalid or
unsafe windows.

`policy.test.ts` locks every endpoint class to ADR-012's exact dimensions,
limits, window, and failure mode. It also proves required subjects fail closed
and conditional workspace/connection dimensions are omitted only when the
request is not scoped to them.

`redis-runtime.test.ts` uses fake timers and an ioredis module mock to prove
client options, stalled-connect and stalled-command deadlines, concurrent
connect deduplication, initial-connect rejection recovery, post-ready reconnect,
closed-runtime rejection, close during an in-flight connect, and the timeout
configuration boundary.

### Real Redis and CI

The API integration suite provides real-Redis evidence through
`RedisRateLimitRuntime` for exact concurrent thresholds, expiry recovery, every
dimension kind, noisy/quiet tenant isolation, and recovery after Redis kills
the production client's connection. It also includes a 10-second elapsed-time
guard.

GitHub Actions runs the package unit tests in the `core` matrix and the
production-runtime Redis suite in the service-backed integration job. Root
`test:coverage` includes the package-owned coverage configuration and enforces
90% statements/lines, 86% branches, and 92% functions.

The tests assert concurrency and security properties rather than implementation
snapshots. The remaining package obligation is deployment-topology evidence,
not an untested repository state transition.

## Findings and required changes

### RL-001 — A resolved connection promise prevents recovery after Redis disconnect

- **Severity:** P1.
- **Classification:** confirmed defect.
- **Status:** fixed in the repository by `1cf2f75`, `69e4b95`, and `01228d5`.
- **Original evidence (audited tree):** `packages/rate-limit/src/redis-runtime.ts:56-65`. After the first
  successful connect, `this.connection` remains a resolved promise. If client
  status later becomes non-`ready`, `this.connection ??=` does not call
  `redis.connect()` again. The direct reproduction completed one first connect,
  changed the client to a disconnected state, then observed the second consume
  fail with a connect count still equal to one. The
  [ioredis reconnect contract](https://github.com/redis/ioredis/blob/main/README.md#auto-reconnect)
  also states that a non-numeric `retryStrategy` result stops automatic
  reconnect and requires an explicit `connect()`; this runtime deliberately
  returns `null` from that strategy.
- **Impact:** after a Redis interruption, safe reads may remain fail-open and
  protected mutations/provider work fail-closed for the lifetime of each API or
  worker process, even after Redis is healthy. Recovery then depends on process
  replacement rather than the documented next-decision behavior.
- **Required change:** model connection state explicitly or clear the cached
  promise after successful settlement while still deduplicating concurrent
  attempts. Ensure a non-ready client starts exactly one fresh connect, and make
  close prevent any later reconnect.
- **Required verification:** add unit tests for concurrent first connect,
  initial rejection followed by success, ready-to-disconnected-to-successful
  reconnect, and close during/after connect. Add a real-Redis test that uses
  `RedisRateLimitRuntime`, interrupts its connection, restores Redis, and proves
  a later bounded decision succeeds.

### RL-002 — Multi-key atomicity assumes a non-clustered Redis topology

- **Severity:** P1 if production cluster mode is enabled; otherwise P3 documentation work.
- **Classification:** unverified production assumption.
- **Status:** external production evidence required; no local code change can
  establish the deployed Redis topology.
- **Evidence:** `packages/rate-limit/src/distributed-rate-limiter.ts:21-47` sends
  independently hashed actor/workspace/connection keys in one script. The
  repository-owned ECS workload manifest supplies only a `REDIS_URL`; it does
  not declare or validate the managed Redis topology. The external platform
  contract remains an open Phase 7 evidence area. Redis documents Lua-script
  keys as single-slot operations in an OSS-clustered deployment.
- **Impact:** Redis Cluster rejects a multi-key operation whose keys occupy
  different hash slots. Simply adding one request-specific hash tag would shard
  actor or workspace counters by the other dimensions and change policy
  semantics, so this cannot be treated as a cosmetic key edit.
- **Required change:** explicitly choose and document a non-clustered replicated
  Redis primary for this V1 atomic policy, and validate that topology in external
  platform evidence; or redesign storage so every required counter can be
  evaluated atomically without weakening cross-request dimension semantics.
- **Required verification:** deployment evidence plus a compatibility test
  against the selected production topology.

### RL-003 — The public decision type does not enforce limiter input invariants

- **Severity:** P2.
- **Classification:** maintainability improvement with fail-safe correctness implications.
- **Status:** fixed in the repository by `1cf2f75` and hardened by `01228d5`.
- **Original evidence (audited tree):** `packages/rate-limit/src/distributed-rate-limiter.ts:78-95`
  rejects only an empty dimension list. Public callers may construct decisions
  with zero, negative, fractional, non-safe, or extreme windows/limits, blank
  identifiers, or duplicate counter keys.
- **Impact:** policy-created decisions are valid today, but direct consumers and
  tests already construct the structural type. Invalid internal construction can
  deny all work, produce surprising expiry behavior, double-increment one key,
  or defer validation to Lua/Redis errors.
- **Required change:** make policy evaluation the sole constructible production
  path, or validate the complete decision once at `consume`. Keep the interface
  small; do not introduce a class hierarchy merely to brand numbers.
- **Required verification:** table-driven invalid-window, invalid-limit, blank
  identifier, duplicate-dimension/key, and valid-edge tests.

### RL-004 — Policy tests do not lock the complete ADR table or conditional scope

- **Severity:** P2.
- **Classification:** maintainability improvement and specification gap.
- **Status:** fixed in the repository by `1cf2f75`.
- **Original evidence (audited tree):** `packages/rate-limit/test/policy.test.ts` directly checks only
  identity start, provider test, actor mutation, workflow compile failure, and
  two failure modes. ADR-012 defines twelve exact endpoint rows and describes
  workspace/connection dimensions as applying “when scoped” or “when selected,”
  while `requiredSubject` always requires every configured dimension.
- **Impact:** accidental changes to most limits can pass package tests. Future
  unscoped routes may fail policy evaluation even if the ADR intended omission
  of a non-applicable dimension.
- **Required change:** decide and document whether conditional dimensions are
  omitted or required by route classification. Then express optionality in rule
  data and data-drive all endpoint classes, dimensions, exact limits, window,
  and failure modes from an explicit expected policy fixture.
- **Required verification:** one exhaustive matrix test plus missing/present
  subject tests for every conditional dimension category.

### RL-005 — Real Redis tests bypass the production runtime

- **Severity:** P2.
- **Classification:** maintainability improvement.
- **Status:** fixed in the repository by `69e4b95`; the service-backed CI cohort
  executes the production runtime and connection-loss recovery assertion.
- **Original evidence (audited tree):** `apps/api/test/rate-limit/distributed-rate-limiter.integration.test.ts:25-33`
  creates and connects ioredis itself, then passes that client directly to
  `DistributedRateLimiter`.
- **Impact:** the strongest environment test cannot detect production adapter
  failures such as RL-001, incorrect lazy-connect behavior, timeout races,
  shutdown defects, or future ioredis option drift.
- **Required change:** retain focused algorithm integration tests, but add a
  production-runtime integration cohort using `RedisRateLimitRuntime`. Reuse the
  repository's bounded Redis stop/restart fixture rather than adding sleeps
  beyond the real expiry assertion required by Redis wall-clock behavior.
- **Required verification:** CI report validation must count the new runtime
  recovery assertion so it cannot silently skip.

### RL-006 — Coverage for the security-sensitive package is measured but not enforced

- **Severity:** P2.
- **Classification:** continuous control gap.
- **Status:** fixed as a continuous repository control by `080c171`; current
  coverage is 95.04% statements, 91.42% branches, 92.3% functions, and 95.69%
  lines.
- **Original evidence (audited tree):** root `test:coverage` includes workflow-engine, database, worker,
  and API only. An ad hoc run measured 84.05% statements and 79.48% branches for
  this package; the concrete Redis runtime has 64.28% branch coverage.
- **Impact:** a future PR may reduce rate-limit coverage while all required
  coverage checks remain green. The current missing branches align with actual
  lifecycle and recovery risk rather than harmless getters.
- **Required change:** add a package-owned coverage script/config with justified
  statement, branch, function, and line thresholds, include it in the root
  critical-module coverage command, and use the risk-review mechanism only for
  branches that are genuinely infeasible to execute.
- **Required verification:** prove the coverage job fails below threshold and
  passes after the RL-001/RL-003/RL-005 state and invariant tests are added.

### RL-007 — The API metric interface widens a finite dimension to arbitrary text

- **Severity:** P3.
- **Classification:** maintainability improvement.
- **Status:** fixed in the repository by `1cf2f75`; the API metric seam retains
  `RateLimitDimensionKind`.
- **Original evidence (audited tree):** `apps/api/src/platform/rate-limit/interceptor.ts:27-34` types
  `limitedDimension?: string`, although the package result provides
  `RateLimitDimensionKind`.
- **Impact:** current calls are safe, but the adapter no longer enforces the
  bounded-cardinality telemetry contract at compile time.
- **Required change:** type the field as `RateLimitDimensionKind` and retain the
  existing `none` fallback only inside the recorder implementation.
- **Required verification:** API typecheck and metric recorder tests covering
  every finite dimension plus the absent case.

### RL-008 — Policy changes are not mechanically coupled to Redis key versioning

- **Severity:** P3.
- **Classification:** maintainability improvement.
- **Status:** fixed in the repository by `1cf2f75` and `01228d5`; the named
  counter-schema version lives beside the policy, drives key construction, is
  covered by a compatibility assertion, and documents when a bump is required.
- **Original evidence (audited tree):** policy limits/window live in `policy.ts`, while the literal
  `pertexo:abuse:v1` namespace lives independently in
  `distributed-rate-limiter.ts:61`.
- **Impact:** a rolling deployment that materially changes window semantics can
  make old and new instances apply different rules to the same counters. A
  simple numeric limit change may be intentionally compatible, but the repository
  has no checklist or test forcing that decision.
- **Required change:** define one named policy/key schema version alongside the
  rules and require an explicit compatibility decision when the policy's counter
  semantics change. Do not automatically version every tuning-only limit edit.
- **Required verification:** a policy compatibility test or documentation gate
  proving the expected namespace for the current rules.

### Current remediation evidence

| Finding | Repository evidence | Verification |
| --- | --- | --- |
| RL-001 | `redis-runtime.ts` clears settled connect attempts, reconnects non-ready clients, and makes shutdown terminal; unit and production-runtime recovery tests cover the state transitions | `pnpm --filter @pertexo/rate-limit test` (29/29); service-backed Redis runtime cohort in CI |
| RL-002 | Intentionally no repository substitution for deployment evidence | Confirm a non-clustered replicated primary and run the compatibility cohort against that deployed topology |
| RL-003 | `distributed-rate-limiter.ts` validates endpoint, window, identifier, limit, and unique counter invariants before Redis I/O | Package unit, typecheck, build, ESLint, and coverage checks pass |
| RL-004 | `policy.test.ts` contains the complete ADR-012 matrix plus required and conditional subject cases | Package unit suite passes |
| RL-005 | The API Redis integration suite constructs `RedisRateLimitRuntime` and kills its client connection before asserting recovery | Service-backed CI cohort; package lifecycle unit suite passes |
| RL-006 | `vitest.coverage.config.ts`, the package script, root `test:coverage`, and CI enforce the package thresholds | 95.04% statements, 91.42% branches, 92.3% functions, 95.69% lines |
| RL-007 | The API recorder accepts only `RateLimitDimensionKind` | `pnpm --filter @pertexo/api typecheck` passes |
| RL-008 | The policy-owned compatibility constant drives key construction and documents incompatible-semantics versioning | Package compatibility assertion passes |

## Non-findings and rejected refactors

- The Lua script is cohesive intentional complexity, not “too much code.”
- Four production files are an appropriate split; combining them would mix
  policy, atomic storage behavior, and client lifecycle, while further splitting
  would add navigation without hiding new complexity.
- `AbuseRateLimitPolicy` is not a useless class. It provides an injectable policy
  interface with negligible ceremony.
- Defensive returned objects and mapped dimensions are appropriate here because
  they prevent callers from mutating shared policy tables; no blanket freeze is
  needed.
- SHA-256 keying is not unnecessary abstraction: it enforces the explicit secret
  and identifier minimization contract.
- The use of `.js` in TypeScript imports is correct `NodeNext` ESM source syntax,
  not mixed-language drift.
- No production `any`, unsafe non-null assertion, ignored promise, circular
  dependency, dead branch, copy-pasted algorithm, or obsolete compatibility shim
  was found in this package.

## Recommended repair order

1. Fix RL-001 and add its state-transition unit regression.
2. Add the production-runtime real-Redis recovery proof in RL-005.
3. Resolve and validate the production topology assumption in RL-002 before
   claiming deploy readiness.
4. Close decision invariants and full policy-table coverage in RL-003/RL-004.
5. Add the critical coverage gate in RL-006.
6. Tighten the metric type and policy-version control in RL-007/RL-008.

After those changes, rerun the package audit against the new tree and mark each
finding complete only with its stated evidence. Do not mark this component's
implementation complete solely from a green 12-test unit run.
