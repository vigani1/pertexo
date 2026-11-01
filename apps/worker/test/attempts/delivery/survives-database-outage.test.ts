import type {
  NodeAttemptLease,
  NodeAttemptRunStore,
} from '@pertexo/core/attempts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { completingThroughOutage } from '../../../src/attempts/delivery/complete-through-outage.js';
import { startNodeAttemptHeartbeat } from '../../../src/attempts/delivery/heartbeat.js';
import type { NodeAttemptHandlerDependencies } from '../../../src/attempts/delivery/contract.js';

const outage = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
  code: 'ECONNREFUSED',
});
const lease = {} as NodeAttemptLease;
const LEASE_SECONDS = 30;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function heartbeating(heartbeat: NodeAttemptRunStore['heartbeat']) {
  return startNodeAttemptHeartbeat(
    {
      heartbeatIntervalMillis: 10_000,
      leaseDurationSeconds: LEASE_SECONDS,
      runStore: { heartbeat },
    } as unknown as NodeAttemptHandlerDependencies,
    lease,
    new AbortController().signal,
  );
}

const renewed = {
  leaseExpiresAt: new Date(),
  control: { kind: 'none' },
} as const;

describe('the heartbeat through a database outage', () => {
  it('keeps the step going while the lease can still hold', async () => {
    let failures = 12;
    const heartbeat = vi.fn(() =>
      failures-- > 0 ? Promise.reject(outage) : Promise.resolve(renewed),
    );
    const running = heartbeating(heartbeat);

    await vi.advanceTimersByTimeAsync(25_000);

    expect(running.executionSignal.aborted).toBe(false);
    expect(running.failure().failed).toBe(false);
    await running.stop();
  });

  // The lease is counted from its last renewal, not from the start of the step.
  it('survives a blip long after the step began', async () => {
    let calls = 0;
    const heartbeat = vi.fn(() => {
      calls += 1;
      return calls === 7 ? Promise.reject(outage) : Promise.resolve(renewed);
    });
    const running = heartbeating(heartbeat);

    await vi.advanceTimersByTimeAsync(75_000);

    expect(calls).toBeGreaterThan(7);
    expect(running.executionSignal.aborted).toBe(false);
    expect(running.failure().failed).toBe(false);
    await running.stop();
  });

  it('counts each outage from the renewal before it', async () => {
    let calls = 0;
    const heartbeat = vi.fn(() => {
      calls += 1;
      // Fails until 25 s, renews once, then fails for another 25 s.
      return calls === 17 ? Promise.resolve(renewed) : Promise.reject(outage);
    });
    const running = heartbeating(heartbeat);

    await vi.advanceTimersByTimeAsync(50_000);

    expect(running.executionSignal.aborted).toBe(false);
    await running.stop();
  });

  it('gives up once the lease can have expired', async () => {
    const running = heartbeating(vi.fn(() => Promise.reject(outage)));

    await vi.advanceTimersByTimeAsync((LEASE_SECONDS + 2) * 1_000);

    expect(running.executionSignal.aborted).toBe(true);
    expect(running.failure().failed).toBe(true);
    await running.stop();
  });

  it('stops at once when ownership is definitely lost', async () => {
    const running = heartbeating(
      vi.fn(() => Promise.reject(new Error('lease was reclaimed'))),
    );

    await vi.advanceTimersByTimeAsync(10_000);

    expect(running.executionSignal.aborted).toBe(true);
    await running.stop();
  });
});

describe('recording a finished step through a database outage', () => {
  const input = {
    signal: new AbortController().signal,
  } as Parameters<NodeAttemptRunStore['complete']>[0];

  it('keeps trying, so a known outcome is not lost', async () => {
    let failures = 12;
    const complete = vi.fn(() =>
      failures-- > 0
        ? Promise.reject(outage)
        : Promise.resolve({
            kind: 'committed',
            outboxEventId: 'event',
          } as const),
    );
    const store = completingThroughOutage(
      { complete } as unknown as NodeAttemptRunStore,
      LEASE_SECONDS,
    );

    const result = store.complete(input);
    await vi.advanceTimersByTimeAsync(13_000);

    await expect(result).resolves.toMatchObject({ kind: 'committed' });
  });

  it('never retries a refusal', async () => {
    const refusal = new Error('stale lease');
    const complete = vi.fn(() => Promise.reject(refusal));
    const store = completingThroughOutage(
      { complete } as unknown as NodeAttemptRunStore,
      LEASE_SECONDS,
    );

    await expect(store.complete(input)).rejects.toBe(refusal);
    expect(complete).toHaveBeenCalledOnce();
  });

  it('stops when the delivery is canceled, without trying again', async () => {
    const canceled = new AbortController();
    const complete = vi.fn(() => Promise.reject(outage));
    const store = completingThroughOutage(
      { complete } as unknown as NodeAttemptRunStore,
      LEASE_SECONDS,
    );

    const result = store.complete({ ...input, signal: canceled.signal });
    const settled = expect(result).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(2_500);
    const callsBeforeCancel = complete.mock.calls.length;
    canceled.abort();
    await vi.advanceTimersByTimeAsync(5_000);

    await settled;
    expect(complete).toHaveBeenCalledTimes(callsBeforeCancel);
  });

  it('stops once the lease can have expired, leaving it to recovery', async () => {
    const complete = vi.fn(() => Promise.reject(outage));
    const store = completingThroughOutage(
      { complete } as unknown as NodeAttemptRunStore,
      LEASE_SECONDS,
    );

    const result = store.complete(input);
    const settled = expect(result).rejects.toBe(outage);
    await vi.advanceTimersByTimeAsync((LEASE_SECONDS + 2) * 1_000);

    await settled;
    const callsWhenItGaveUp = complete.mock.calls.length;
    expect(callsWhenItGaveUp).toBeGreaterThan(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(complete).toHaveBeenCalledTimes(callsWhenItGaveUp);
  });
});
