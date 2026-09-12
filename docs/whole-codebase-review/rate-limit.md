# Rate-limit package — file-by-file judgment

Primary review: all 12 files read, including complete test bodies and build
configuration. Criteria refer to the [rubric](../whole-codebase-quality-plan.md).
No source change made. Real Redis qualification is separate from this review.

| File | Judgment | Reason / required work |
| --- | --- | --- |
| `packages/rate-limit/src/policy.ts` | KEEP — J01–J06, J09, J11 | The endpoint decision table is clearer than a growing conditional chain. Required/optional subject handling is localized and trimming is explicit. Twelve rows represent real policy, not excessive conditions. Keep the table and fixed 60-second window. |
| `packages/rate-limit/src/distributed-rate-limiter.ts` | KEEP — J01–J03, J06, J09–J11 | Separate decision validation, hashed key construction, Lua atomic consumption and result decoding are meaningful concepts. The two Lua passes deliberately check every dimension before incrementing any; merging them would introduce partial consumption. Retry clamping is explicit. Do not extract each guard into a trivial helper. |
| `packages/rate-limit/src/redis-runtime.ts` | TEST/CONDITIONAL — WQ-001; J07, J08, J12 | Connect deduplication, operation deadline and closed-state checks are coherent. `close()` lines 53–63 only awaits `quit()` for a ready client; failure does not explicitly disconnect. Add failure/timeout teardown evidence before claiming closed socket ownership. Keep `isClosed()` unless the compiler's post-await narrowing permits direct access without a cast. |
| `packages/rate-limit/src/index.ts` | KEEP — J05, J13 | Small intentional package facade; no local algorithm or duplicative business logic. |
| `packages/rate-limit/test/policy.test.ts` | KEEP — J12 | Full expected decision table independently pins policy rather than deriving expected values from RULES. Missing required subjects and absent optional dimensions are covered. The repeated expected table is useful specification duplication. |
| `packages/rate-limit/test/distributed-rate-limiter.test.ts` | KEEP — J09, J12 | Fake executor checks arguments and malformed decisions/results. Tests correctly do not claim to execute Lua; real atomicity belongs to API Redis integration suites. |
| `packages/rate-limit/test/redis-runtime.test.ts` | TEST — WQ-001; J07, J12 | Fake timers cover stalled connect/eval and close-vs-connect. Add ready-client quit rejection/timeout, repeated close promise identity, and terminal socket disposal; existing success close does not prove those paths. |
| `packages/rate-limit/package.json` | KEEP — J13 | Private ESM package, explicit compiled exports and one actual runtime dependency. Preserve the current runner/build. |
| `packages/rate-limit/tsconfig.json` | KEEP — J13 | Explicit NodeNext/composite declaration output is consistent with built workspace consumption. No buildless conversion. |
| `packages/rate-limit/tsconfig.test.json` | KEEP — J12, J13 | Includes source, tests and both Vitest configs without emitting production artifacts. |
| `packages/rate-limit/vitest.config.ts` | KEEP — J12 | Narrow test include and Node environment; no production behavior. |
| `packages/rate-limit/vitest.coverage.config.ts` | KEEP — J12 | Measures all package source with explicit report directory and thresholds. Coverage percentage does not replace WQ-001's missing failure assertion. |

## WQ-001 — prove terminal Redis cleanup after QUIT fails

**Priority:** P2 test/operability. **Evidence:** source and dependency-path
inspection; socket retention has not been reproduced against a live server.

Current `redis-runtime.ts:53`:

```ts
if (this.redis.status === 'ready')
  this.closePromise = this.redis.quit().then(() => undefined);
```

The runtime marks itself closed and caches rejection, but contains no explicit
disconnect fallback. ioredis command timeout rejects a command promise; it is
not itself evidence that the underlying socket has been destroyed. The API
Nest shutdown hook and worker capability owner both rely on this close method.

1. Extend `packages/rate-limit/test/redis-runtime.test.ts` with ready-client
   rejected/timed-out QUIT; assert terminal disposal, no reconnect, identical
   repeated close promise and retention of the original quit error.
2. Check pinned ioredis behavior with a bounded local protocol fixture if the
   mock alone cannot establish the socket contract. No deployed Redis needed.
3. If it does not guarantee disposal, make `close()` finish with a guarded
   disconnect after the bounded graceful quit attempt. Cache before invoking
   effects if supporting synchronous throws. Do not route close through the
   ordinary consume deadline or reopen the runtime on failure.
4. Keep callers' resource ownership unchanged. If the dependency proves
   guaranteed disposal, retain source and keep the regression as evidence.

Acceptance: no live socket/reconnect after close success or failure; repeated
close does not retry quit; initiating quit failure remains observable. Run
`pnpm --filter @pertexo/rate-limit test` and package typecheck, then the existing
API limiter integration cohorts when local Redis is explicitly available.
