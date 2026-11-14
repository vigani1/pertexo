# @pertexo/rate-limit

Follow the [root rules](../../AGENTS.md); this file only adds to them.

## Purpose and boundary

Abuse rate limits: which budgets a request counts against (the policy), and
counting them in Redis or, while Redis is out, in process memory. It also
lends the worker short exclusive admission slots in the same Redis.

Node only (`@pertexo/rate-limit/server`). It depends on `ioredis` alone. The
API's admission interceptor and the worker's provider calls use it. It never
decides what a refused request looks like (each transport shapes its own
problem), never reads the environment (the caller passes the Redis URL) and
never logs or records metrics (the caller does, from the result).

## Layout

- `src/server.ts`: the entry.
- `src/rate-limit-policy.ts`: endpoint classes, their budgets and failure
  modes, and `AbuseRateLimitPolicy`, which turns a request into a decision.
  Pure.
- `src/limiters/`: `distributed-rate-limiter.ts` counts a decision with one
  Redis script; `local-rate-limiter.ts` counts it in memory with the same
  rule.
- `src/redis-rate-limit.runtime.ts`: the Redis client's lifetime, deadlines
  and exclusive slots.
- `src/rate-limit.errors.ts`: `RateLimitDecisionError` and
  `RateLimitBackendError`.

## Where new code goes

- A new endpoint class: add it to `RATE_LIMIT_ENDPOINT_CLASSES` and `RULES` in
  `rate-limit-policy.ts`; if the automation guide publishes it, add its row to
  `test/published-limits.test.ts`.
- A new counting backend: a limiter in `limiters/` returning
  `DistributedRateLimitResult`.
- A new Redis operation: a method on `RedisRateLimitRuntime`, run through
  `withDeadline`.

## Defaults and config

- Budgets: the `RULES` table; the window: `RATE_LIMIT_WINDOW_SECONDS`.
- Memory fallback size: `MAX_COUNTERS` in `local-rate-limiter.ts`.
- Redis operation timeout (default and bounds) and the slot lifetime ceiling:
  constants at the top of `redis-rate-limit.runtime.ts`. The Redis URL and any
  timeout override come from the calling app's config.

## Rules

- The policy stays pure; limiters stay free of budget rules.
- Both limiters apply the same increment and refusal rule; a change to one is
  a change to both, and both test files say so.
- Store failures are `RateLimitBackendError`, so callers apply the decision's
  failure mode instead of guessing.

## Exceptions

- Two named concepts sit at the `src` root beside the entry: the policy and
  the Redis runtime. Each is the package's one file of its kind.

## What guards it

- `pnpm --filter @pertexo/rate-limit test`: the policy table, both limiters,
  the runtime against a fake Redis protocol server, and that the automation
  guide states the real budgets. No Docker needed.
- `pnpm check`: package structure, naming, environment and backend-limits
  checks.
