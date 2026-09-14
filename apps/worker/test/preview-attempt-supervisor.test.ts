import { randomUUID } from 'node:crypto';

import type { PreviewAttemptLease } from '@pertexo/database/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startPreviewAttemptSupervisor } from '../src/execution/preview-attempt-supervisor.js';

function leaseFixture(deadlineAt = new Date(Date.now() + 4 * 60_000)) {
  return {
    attemptFenceToken: 1,
    executionDeadlineAt: deadlineAt,
    previewAttemptId: randomUUID(),
    previewRunId: randomUUID(),
    workspaceId: randomUUID(),
  } as PreviewAttemptLease;
}

function abortResponsiveDelay(
  _milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        resolve();
      },
      { once: true },
    );
  });
}

function heartbeatResult() {
  return {
    attemptLeaseExpiresAt: new Date(Date.now() + 30_000),
    runExecutionDeadlineAt: new Date(Date.now() + 4 * 60_000),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('preview attempt supervisor ownership', () => {
  it('stops before the first tick without starting a heartbeat', async () => {
    const heartbeat = vi.fn(() => Promise.resolve(heartbeatResult()));
    const supervisor = startPreviewAttemptSupervisor(
      {
        contextSignal: new AbortController().signal,
        heartbeatIntervalMillis: 1_000,
        lease: leaseFixture(),
        leaseDurationSeconds: 30,
        runStore: { heartbeat },
        workerId: 'worker-preview-test',
      },
      abortResponsiveDelay,
    );

    await supervisor.stop();
    expect(heartbeat).not.toHaveBeenCalled();
  });

  it('turns a rejected delay seam into an owned lease failure', async () => {
    const delayFailure = new Error('delay failed');
    const invocation = Promise.withResolvers<string>();
    const supervisor = startPreviewAttemptSupervisor(
      {
        contextSignal: new AbortController().signal,
        heartbeatIntervalMillis: 1_000,
        lease: leaseFixture(),
        leaseDurationSeconds: 30,
        runStore: { heartbeat: vi.fn() },
        workerId: 'worker-preview-test',
      },
      () => Promise.reject(delayFailure),
    );

    await expect(supervisor.race(invocation.promise)).resolves.toEqual({
      error: delayFailure,
      kind: 'lease_failure',
    });
    invocation.resolve('late');
    await supervisor.stop();
  });

  it('contains heartbeat result interpretation failures', async () => {
    const resultFailure = new Error('invalid heartbeat result');
    const invocation = Promise.withResolvers<string>();
    const supervisor = startPreviewAttemptSupervisor(
      {
        contextSignal: new AbortController().signal,
        heartbeatIntervalMillis: 1_000,
        lease: leaseFixture(),
        leaseDurationSeconds: 30,
        runStore: {
          heartbeat: () =>
            Promise.resolve({
              ...heartbeatResult(),
              runExecutionDeadlineAt: {
                getTime: () => {
                  throw resultFailure;
                },
              } as unknown as Date,
            }),
        },
        workerId: 'worker-preview-test',
      },
      () => Promise.resolve(),
    );

    await expect(supervisor.race(invocation.promise)).resolves.toEqual({
      error: resultFailure,
      kind: 'lease_failure',
    });
    invocation.resolve('late');
    await supervisor.stop();
  });

  it.each(['resolve', 'reject'] as const)(
    'waits for an in-flight heartbeat to %s when stopping',
    async (settlement) => {
      const heartbeatStarted = Promise.withResolvers<undefined>();
      const heartbeatFinished =
        Promise.withResolvers<ReturnType<typeof heartbeatResult>>();
      const supervisor = startPreviewAttemptSupervisor(
        {
          contextSignal: new AbortController().signal,
          heartbeatIntervalMillis: 1_000,
          lease: leaseFixture(),
          leaseDurationSeconds: 30,
          runStore: {
            heartbeat: () => {
              heartbeatStarted.resolve(undefined);
              return heartbeatFinished.promise;
            },
          },
          workerId: 'worker-preview-test',
        },
        () => Promise.resolve(),
      );
      await heartbeatStarted.promise;
      await expect(supervisor.race(Promise.resolve('done'))).resolves.toEqual({
        kind: 'outcome',
        outcome: 'done',
      });

      const stop = supervisor.stop();
      let stopped = false;
      void stop.then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      if (settlement === 'resolve')
        heartbeatFinished.resolve(heartbeatResult());
      else heartbeatFinished.reject(new Error('late heartbeat failure'));
      await stop;
      expect(supervisor.stop()).toBe(stop);
    },
  );

  it.each(['resolve', 'reject'] as const)(
    'keeps a deadline-losing invocation owned through its late %s',
    async (settlement) => {
      vi.useFakeTimers();
      const invocation = Promise.withResolvers<string>();
      const supervisor = startPreviewAttemptSupervisor(
        {
          contextSignal: new AbortController().signal,
          heartbeatIntervalMillis: 1_000,
          lease: leaseFixture(new Date(Date.now() + 100)),
          leaseDurationSeconds: 30,
          runStore: { heartbeat: vi.fn() },
          workerId: 'worker-preview-test',
        },
        abortResponsiveDelay,
      );
      const race = supervisor.race(invocation.promise);
      await vi.advanceTimersByTimeAsync(100);
      await expect(race).resolves.toBe('deadline');

      const stop = supervisor.stop();
      let stopped = false;
      void stop.then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      if (settlement === 'resolve') invocation.resolve('late');
      else invocation.reject(new Error('late invocation failure'));
      await stop;
    },
  );

  it('preserves an invocation result that wins immediately before deadline', async () => {
    vi.useFakeTimers();
    const invocation = Promise.withResolvers<string>();
    const supervisor = startPreviewAttemptSupervisor(
      {
        contextSignal: new AbortController().signal,
        heartbeatIntervalMillis: 1_000,
        lease: leaseFixture(new Date(Date.now() + 100)),
        leaseDurationSeconds: 30,
        runStore: { heartbeat: vi.fn() },
        workerId: 'worker-preview-test',
      },
      abortResponsiveDelay,
    );
    const race = supervisor.race(invocation.promise);
    await vi.advanceTimersByTimeAsync(99);
    invocation.resolve('truthful result');
    await expect(race).resolves.toEqual({
      kind: 'outcome',
      outcome: 'truthful result',
    });
    await supervisor.stop();
  });

  it('surfaces transport revocation while retaining invocation ownership', async () => {
    const context = new AbortController();
    const invocation = Promise.withResolvers<string>();
    const supervisor = startPreviewAttemptSupervisor(
      {
        contextSignal: context.signal,
        heartbeatIntervalMillis: 1_000,
        lease: leaseFixture(),
        leaseDurationSeconds: 30,
        runStore: { heartbeat: vi.fn() },
        workerId: 'worker-preview-test',
      },
      abortResponsiveDelay,
    );
    const reason = new Error('transport revoked');
    const race = supervisor.race(invocation.promise);
    context.abort(reason);
    await expect(race).resolves.toEqual({ error: reason, kind: 'error' });

    const stop = supervisor.stop();
    let stopped = false;
    void stop.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    invocation.resolve('late');
    await stop;
  });
});
