import { describe, expect, it } from 'vitest';

import { LocalRateLimiter } from '../src/local-rate-limiter.js';
import type { RateLimitDecision } from '../src/policy.js';

const decision = (
  overrides: Partial<RateLimitDecision> = {},
): RateLimitDecision => ({
  endpointClass: 'identity_start',
  failureMode: 'closed',
  windowSeconds: 60,
  dimensions: [{ kind: 'client_address', identifier: 'a', limit: 3 }],
  ...overrides,
});

function atClock(start = 1_000_000) {
  let now = start;
  return {
    limiter: new LocalRateLimiter(() => now),
    move: (millis: number) => {
      now += millis;
    },
  };
}

const consumeTimes = (
  limiter: LocalRateLimiter,
  times: number,
  selected = decision(),
) => Array.from({ length: times }, () => limiter.consume(selected));

describe('LocalRateLimiter', () => {
  it('allows up to the limit, then refuses and says how long to wait', () => {
    const { limiter } = atClock();

    expect(consumeTimes(limiter, 3)).toEqual([
      { allowed: true, quota: { limit: 3, remaining: 2, resetSeconds: 60 } },
      { allowed: true, quota: { limit: 3, remaining: 1, resetSeconds: 60 } },
      { allowed: true, quota: { limit: 3, remaining: 0, resetSeconds: 60 } },
    ]);
    expect(limiter.consume(decision())).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
      limitedDimension: 'client_address',
    });
  });

  it('counts down the wait from the first request, and opens when the window ends', () => {
    const { limiter, move } = atClock();
    consumeTimes(limiter, 3);

    move(59_001);
    expect(limiter.consume(decision())).toMatchObject({
      allowed: false,
      retryAfterSeconds: 1,
    });

    move(999);
    expect(limiter.consume(decision())).toMatchObject({ allowed: true });
  });

  // Refusals don't extend a window, or a client could never get back in.
  it('doesn’t move the window for requests inside it', () => {
    const { limiter, move } = atClock();
    consumeTimes(limiter, 3);
    move(30_000);
    consumeTimes(limiter, 5);

    move(30_000);

    expect(limiter.consume(decision())).toMatchObject({ allowed: true });
  });

  // Allowed requests don't either, or a steady client would never see the window end.
  it('keeps the window from the first request as later ones arrive', () => {
    const { limiter, move } = atClock();
    const limitOfTwo = decision({
      dimensions: [{ kind: 'client_address', identifier: 'a', limit: 2 }],
    });
    limiter.consume(limitOfTwo);
    move(30_000);
    limiter.consume(limitOfTwo);
    expect(limiter.consume(limitOfTwo)).toMatchObject({
      allowed: false,
      retryAfterSeconds: 30,
    });

    move(30_000);

    expect(limiter.consume(limitOfTwo)).toMatchObject({ allowed: true });
  });

  it('starts a fresh count after the window', () => {
    const { limiter, move } = atClock();
    consumeTimes(limiter, 3);
    move(60_000);

    consumeTimes(limiter, 3);

    expect(limiter.consume(decision())).toMatchObject({ allowed: false });
  });

  it('keeps separate counts per client and per endpoint', () => {
    const { limiter } = atClock();
    consumeTimes(limiter, 3);

    expect(
      limiter.consume(
        decision({
          dimensions: [{ kind: 'client_address', identifier: 'b', limit: 3 }],
        }),
      ),
    ).toMatchObject({ allowed: true });
    expect(
      limiter.consume(decision({ endpointClass: 'run_admission' })),
    ).toMatchObject({ allowed: true });
    expect(limiter.consume(decision())).toMatchObject({ allowed: false });
  });

  describe('with several dimensions', () => {
    const client = {
      kind: 'client_address',
      identifier: 'a',
      limit: 10,
    } as const;
    const account = { kind: 'account', identifier: 'x', limit: 2 } as const;
    const both = decision({ dimensions: [client, account] });

    it('names the dimension that refused', () => {
      const { limiter } = atClock();
      consumeTimes(limiter, 2, both);

      expect(limiter.consume(both)).toMatchObject({
        allowed: false,
        limitedDimension: 'account',
      });
    });

    // Otherwise someone guessing one account's password would use up their address
    // for every other account, on requests that were refused anyway.
    it('counts nothing on any dimension when one refuses', () => {
      const { limiter } = atClock();
      consumeTimes(limiter, 2, both);
      consumeTimes(limiter, 20, both);

      const clientAlone = decision({ dimensions: [{ ...client, limit: 3 }] });
      expect(limiter.consume(clientAlone)).toMatchObject({ allowed: true });
      expect(limiter.consume(clientAlone)).toMatchObject({ allowed: false });
    });

    it('gives the longest wait when several refuse', () => {
      const { limiter, move } = atClock();
      const early = decision({
        dimensions: [{ kind: 'client_address', identifier: 'a', limit: 1 }],
      });
      limiter.consume(early);
      move(30_000);
      const late = decision({
        dimensions: [{ kind: 'account', identifier: 'x', limit: 1 }],
      });
      limiter.consume(late);

      expect(
        limiter.consume(
          decision({
            dimensions: [...early.dimensions, ...late.dimensions],
          }),
        ),
      ).toEqual({
        allowed: false,
        retryAfterSeconds: 60,
        limitedDimension: 'account',
      });
    });
  });

  describe('how many counters it holds', () => {
    const MAX_COUNTERS = 50_000;
    const forClient = (identifier: string, windowSeconds = 60) =>
      decision({
        windowSeconds,
        dimensions: [{ kind: 'client_address', identifier, limit: 1 }],
      });
    const isCounted = (limiter: LocalRateLimiter, identifier: string) =>
      !limiter.consume(forClient(identifier)).allowed;

    // An address-rotating flood during an outage mustn't use up the process's memory.
    it('forgets the oldest counter past its bound, and only that one', () => {
      const { limiter } = atClock();
      for (let index = 0; index < MAX_COUNTERS; index += 1)
        limiter.consume(forClient(String(index)));

      limiter.consume(forClient('one more'));

      expect(isCounted(limiter, String(MAX_COUNTERS - 1))).toBe(true);
      expect(isCounted(limiter, '1')).toBe(true);
      expect(isCounted(limiter, 'one more')).toBe(true);
      expect(isCounted(limiter, '0')).toBe(false);
    });

    it('frees what has expired before forgetting a live counter', () => {
      const { limiter, move } = atClock();
      limiter.consume(forClient('oldest and live'));
      limiter.consume(forClient('expires soon', 1));
      for (let index = 2; index < MAX_COUNTERS; index += 1)
        limiter.consume(forClient(String(index)));
      move(1_000);

      limiter.consume(forClient('one more'));

      expect(isCounted(limiter, 'oldest and live')).toBe(true);
      expect(isCounted(limiter, 'one more')).toBe(true);
    });
  });
});
