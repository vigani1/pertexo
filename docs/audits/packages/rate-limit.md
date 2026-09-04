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
- **Audit status:** complete for the pinned tree.
- **Implementation status:** one confirmed high-severity recovery defect, two
  unverified/underspecified production risks, and five test or maintainability
  improvements remain open.

The package has a good core design: it is cohesive, has no dependency cycle,
keeps the policy vocabulary in one place, hashes subject identifiers, and uses
one atomic Lua operation across all applicable dimensions. Its production
surface is readable and materially deeper than its small public interface. It
is not yet “finished” as a production control because the production Redis
runtime does not recover after a post-connect disconnect, the actual runtime is
not exercised against real Redis, and CI does not enforce coverage for this
security-sensitive package.

The audit does not recommend splitting these files. No function is difficult
because of size, no repeated production algorithm warrants extraction, and no
dead production abstraction was found. The necessary work is behavioral and
verification-focused.

## Evidence collected

The review used full-file reading, repository-wide symbol/import searches,
direct-consumer tracing, plan/ADR comparison, TypeScript compilation, package
build, ESLint, all package tests, an ad hoc V8 coverage run, and a direct runtime
state-transition reproduction.

| Check | Result |
| --- | --- |
| `pnpm --filter @pertexo/rate-limit typecheck` | Passed |
| `pnpm --filter @pertexo/rate-limit test` | 3 files and 12 tests passed |
| `pnpm --filter @pertexo/rate-limit build` | Passed |
| `pnpm exec eslint packages/rate-limit` | Passed |
| Ad hoc package V8 coverage | 84.05% statements, 79.48% branches, 86.95% functions, 87.5% lines |
| Real-Redis suite inspection | Executed by the service-backed CI job, but it instantiates `DistributedRateLimiter` directly rather than `RedisRateLimitRuntime` |
| Disconnect reproduction | First consume connected and succeeded; after simulated connection loss, the second consume failed and the connect count remained 1 |

The coverage figures are measurements, not an enforced repository baseline.
They include all `src/` files, with `policy.ts` at 100% of instrumented metrics,
`distributed-rate-limiter.ts` at 86.95% lines/85.71% branches, and
`redis-runtime.ts` at 83.87% lines/64.28% branches.

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
| `counterKey` | Uses SHA-256 over endpoint class, dimension kind, and identifier with NUL separators. Raw subject identifiers never enter Redis keys. The explicit bounds error is correct defensive programming. Prefix versioning exists but is manually maintained (RL-008). |
| `parseScriptResult` | Validates tuple shape and integer elements before its single justified tuple assertion. There is no `any`, unchecked external cast, or silent allow path. |
| `DistributedRateLimiter.constructor` | Accepts its only dependency explicitly. This is testable and avoids hidden process-global Redis state. |
| `DistributedRateLimiter.consume` | Readable orchestration: validate non-empty input, derive keys, make one operation, decode allow/reject, bound retry to 1–60 seconds, and return a finite dimension kind. Its missing numeric/duplicate-dimension validation is RL-003. |

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
| `close` | Correctly chooses graceful `quit` only for a ready client and immediate disconnect otherwise. Both branches lack direct package-test coverage (RL-005/RL-006). |
| `connect` | Correctly deduplicates concurrent first connects and clears the promise after an initial rejection. It fails to clear a successfully resolved promise when the client later leaves `ready`, preventing reconnection (RL-001). |
| `withDeadline` | Owns and unreferences its timer, clears it in `finally`, disconnects on expiry, and treats a racing unknown Redis outcome conservatively. The timer does not cancel JavaScript work itself; disconnect is the correct available cancellation mechanism for this client. |
| `operationTimeout` | Applies a finite default and validates a safe 100–10,000 ms integer range. Tests cover only the lower rejection and one accepted value, not the default, upper edge, upper rejection, fractional, or non-finite cases. |

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

One type loses precision at this seam: `RateLimitMetricRecorder` widens
`limitedDimension` from `RateLimitDimensionKind` to `string` (RL-007). Current
production calls remain finite, but the interface no longer prevents a future
high-cardinality value.

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
keys, argument ordering, a capped rejection result, and fail-safe malformed
reply handling. It does not prove empty dimensions, the full invalid reply
matrix, retry rounding at lower and upper edges, duplicate dimensions, numeric
invariants, or key isolation/stability.

`policy.test.ts` proves representative identity, provider, actor-only, missing
subject, and fail-mode cases. It does not data-drive all endpoint classes
against ADR-012's complete expected table, and therefore would not catch many
accidental limit edits. It also does not settle conditional “when scoped”
behavior.

`redis-runtime.test.ts` uses fake timers and an ioredis module mock to prove
client options, stalled-connect timeout, stalled-command timeout, and one lower
configuration bound. It does not prove successful consumption, concurrent
connect deduplication, initial-connect rejection recovery, post-ready disconnect
recovery, deadline cleanup after success, close branches, or most timeout
validation edges. Its “resets the socket for the next decision” test checks only
that `disconnect` was called; it never makes the next decision, which allowed
RL-001 to pass.

### Real Redis and CI

The API integration suite provides valuable real-Redis evidence for exact
concurrent thresholds, expiry recovery, every dimension kind, and noisy/quiet
tenant isolation. It also includes a 10-second elapsed-time guard. However, it
constructs `DistributedRateLimiter` around its own already-connected Redis
client. It therefore proves the Lua algorithm but bypasses every production
behavior in `RedisRateLimitRuntime`: lazy connect, operation deadline, reconnect,
client options, and close.

GitHub Actions runs the package's 12 unit tests in the `core` matrix and the
real-Redis algorithm suite in the service-backed integration job. The package
is not included in root `test:coverage`, whose enforced critical cohorts are
workflow-engine, database, worker, and API. Passing CI thus means the existing
rate-limit tests ran; it does not mean all rate-limit branches or production
runtime states are covered.

The tests are useful rather than ceremonial: they assert concurrency and
security properties, not implementation snapshots. The principal weakness is
missing state-transition coverage at the concrete Redis adapter.

## Findings and required changes

### RL-001 — A resolved connection promise prevents recovery after Redis disconnect

- **Severity:** P1.
- **Classification:** confirmed defect.
- **Status:** open.
- **Evidence:** `packages/rate-limit/src/redis-runtime.ts:56-65`. After the first
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
- **Status:** open.
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
- **Status:** open.
- **Evidence:** `packages/rate-limit/src/distributed-rate-limiter.ts:78-95`
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
- **Status:** open.
- **Evidence:** `packages/rate-limit/test/policy.test.ts` directly checks only
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
- **Status:** open.
- **Evidence:** `apps/api/test/rate-limit/distributed-rate-limiter.integration.test.ts:25-33`
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
- **Status:** open.
- **Evidence:** root `test:coverage` includes workflow-engine, database, worker,
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
- **Status:** open.
- **Evidence:** `apps/api/src/platform/rate-limit/interceptor.ts:27-34` types
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
- **Status:** open.
- **Evidence:** policy limits/window live in `policy.ts`, while the literal
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
