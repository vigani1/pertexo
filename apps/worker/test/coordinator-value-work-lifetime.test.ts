import { PassThrough, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCoordinatorValueWorkLifetime,
  COORDINATOR_VALUE_WORK_POLICY_DEFAULTS,
  type CoordinatorValueWorkOwner,
  type InspectCoordinatorValueOwner,
  type CoordinatorValueWorkSession,
} from '../src/execution/coordinator-value-work-lifetime.js';
import { waitForCancelableDelay } from '../src/runtime/abortable-delay.js';

const owner: CoordinatorValueWorkOwner = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  workflowVersionId: '33333333-3333-4333-8333-333333333333',
  delivery: {
    outboxEventId: '44444444-4444-4444-8444-444444444444',
    payloadChecksum: 'a'.repeat(64),
  },
  expectedRevision: 4,
};
const active = {
  kind: 'active' as const,
  databaseNow: '2026-10-03T00:00:00.000Z',
  deadlineAt: null,
};
const signal = () => new AbortController().signal;
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new DOMException('Operation aborted', 'AbortError');
}

describe('callback-scoped coordinator value work', () => {
  it('exposes one scoped cancellation signal without initializing value work on a lazy path', async () => {
    const inspectOwner = vi.fn().mockResolvedValue(active);
    const lifetime = createCoordinatorValueWorkLifetime({
      policy: COORDINATOR_VALUE_WORK_POLICY_DEFAULTS,
      inspectOwner,
    });
    const context = new AbortController();
    let scopedSignal: AbortSignal | undefined;
    await expect(
      lifetime.withValueWork(owner, context.signal, (session) => {
        scopedSignal = session.signal;
        expect(scopedSignal).toBeInstanceOf(AbortSignal);
        expect(session.signal).toBe(scopedSignal);
        expect(scopedSignal).not.toBe(context.signal);
        expect(scopedSignal.aborted).toBe(false);
        return Promise.resolve('literal');
      }),
    ).resolves.toEqual({ kind: 'completed', value: 'literal' });
    expect(inspectOwner).not.toHaveBeenCalled();
    expect(scopedSignal?.aborted).toBe(true);
    expect(getEventListeners(context.signal, 'abort')).toHaveLength(0);
  });
  it('aborts active preparation when a watcher read stalls and joins both cleanup paths', async () => {
    vi.useFakeTimers();
    const started = Promise.withResolvers<undefined>();
    const readStarted = Promise.withResolvers<undefined>();
    const streamCleaned = Promise.withResolvers<undefined>();
    const releaseRead = Promise.withResolvers<undefined>();
    const releaseStream = Promise.withResolvers<undefined>();
    const context = new AbortController();
    let readSignal: AbortSignal | undefined;
    let reads = 0;
    const inspectOwner: InspectCoordinatorValueOwner = (input) => {
      if (++reads === 1) return Promise.resolve(active);
      readSignal = input.signal;
      readStarted.resolve(undefined);
      return new Promise((_resolve, reject) => {
        input.signal.addEventListener(
          'abort',
          () => {
            void releaseRead.promise.then(() => {
              reject(abortError(input.signal));
            });
          },
          { once: true },
        );
      });
    };
    const lifetime = createCoordinatorValueWorkLifetime({
      policy: COORDINATOR_VALUE_WORK_POLICY_DEFAULTS,
      inspectOwner,
    });
    const source = new PassThrough();
    const destination = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    let finished = false;
    const result = lifetime
      .withValueWork(owner, context.signal, (session) =>
        session.perform(async (workSignal) => {
          started.resolve(undefined);
          try {
            await pipeline(source, destination, { signal: workSignal });
          } finally {
            streamCleaned.resolve(undefined);
            await releaseStream.promise;
          }
        }),
      )
      .then((outcome) => {
        finished = true;
        return outcome;
      });
    await started.promise;
    try {
      await vi.advanceTimersByTimeAsync(250);
      await readStarted.promise;
      await vi.advanceTimersByTimeAsync(1_999);
      expect(source.destroyed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await streamCleaned.promise;
      expect(readSignal?.aborted).toBe(true);
      expect(source.destroyed).toBe(true);
      expect(destination.destroyed).toBe(true);
      expect(finished).toBe(false);
      releaseStream.resolve(undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(finished).toBe(false);
      releaseRead.resolve(undefined);
      await expect(result).resolves.toEqual({
        kind: 'stopped',
        stop: { kind: 'unavailable', reason: 'control_read_failed' },
      });
      expect(vi.getTimerCount()).toBe(0);
      expect(getEventListeners(context.signal, 'abort')).toHaveLength(0);
    } finally {
      releaseRead.resolve(undefined);
      releaseStream.resolve(undefined);
      context.abort();
      await result;
    }
  });
  it('discards an operation result when the post-work owner recheck is stale', async () => {
    const inspectOwner = vi
      .fn()
      .mockResolvedValueOnce(active)
      .mockResolvedValue({
        kind: 'stopped',
        stop: { kind: 'stale', revision: 5 },
      });
    const operation = vi.fn().mockResolvedValue('must-not-escape');
    const lifetime = createCoordinatorValueWorkLifetime({
      policy: COORDINATOR_VALUE_WORK_POLICY_DEFAULTS,
      inspectOwner,
    });
    await expect(
      lifetime.withValueWork(owner, signal(), (session) =>
        session.perform(operation),
      ),
    ).resolves.toEqual({
      kind: 'stopped',
      stop: { kind: 'stale', revision: 5 },
    });
    expect(operation).toHaveBeenCalledOnce();
  });

  it('retains the original actual owner routing despite adapter or caller request mutation', async () => {
    const callerOwner = structuredClone(owner);
    const observed: string[] = [];
    const inspectOwner = vi.fn<InspectCoordinatorValueOwner>((input) => {
      observed.push(input.owner.delivery.payloadChecksum);
      Reflect.set(input.owner.delivery, 'payloadChecksum', 'b'.repeat(64));
      return Promise.resolve(active);
    });
    const lifetime = createCoordinatorValueWorkLifetime({
      policy: COORDINATOR_VALUE_WORK_POLICY_DEFAULTS,
      inspectOwner,
    });
    await expect(
      lifetime.withValueWork(callerOwner, signal(), (session) =>
        session.perform(() => {
          Reflect.set(callerOwner.delivery, 'payloadChecksum', 'c'.repeat(64));
          return Promise.resolve('decoded');
        }),
      ),
    ).resolves.toEqual({ kind: 'completed', value: 'decoded' });
    expect(observed).toEqual(['a'.repeat(64), 'a'.repeat(64)]);
  });

  it.each([
    { kind: 'active', databaseNow: 'not-a-time', deadlineAt: null },
    {
      kind: 'active',
      databaseNow: active.databaseNow,
      deadlineAt: 'not-a-deadline',
    },
    { kind: 'stopped', stop: { kind: 'unavailable', reason: 'invented' } },
  ])(
    'preserves malformed owner replies as integrity errors rather than semantic failure or outage (%j)',
    async (reply) => {
      const inspectOwner = vi.fn().mockResolvedValue(reply);
      const operation = vi.fn();
      const lifetime = createCoordinatorValueWorkLifetime({
        policy: COORDINATOR_VALUE_WORK_POLICY_DEFAULTS,
        inspectOwner,
      });
      await expect(
        lifetime.withValueWork(owner, signal(), (session) =>
          session.perform(operation),
        ),
      ).rejects.toBeInstanceOf(TypeError);
      expect(operation).not.toHaveBeenCalled();
    },
  );
  it('does not hide an owner integrity failure discovered while joining the watcher on scope exit', async () => {
    vi.useFakeTimers();
    const returnCallback = Promise.withResolvers<undefined>();
    const callbackReady = Promise.withResolvers<undefined>();
    const watcherReadStarted = Promise.withResolvers<undefined>();
    const releaseReadCleanup = Promise.withResolvers<undefined>();
    const failure = new Error('Actual coordinator owner state is corrupt');
    let reads = 0;
    const inspectOwner = vi.fn<InspectCoordinatorValueOwner>((input) => {
      reads += 1;
      if (reads <= 2) return Promise.resolve(active);
      watcherReadStarted.resolve(undefined);
      return new Promise((_resolve, reject) => {
        input.signal.addEventListener(
          'abort',
          () => {
            void releaseReadCleanup.promise.then(() => {
              reject(failure);
            });
          },
          { once: true },
        );
      });
    });
    const context = new AbortController();
    const lifetime = createCoordinatorValueWorkLifetime({
      policy: COORDINATOR_VALUE_WORK_POLICY_DEFAULTS,
      inspectOwner,
    });
    let finished = false;
    const result = lifetime.withValueWork(
      owner,
      context.signal,
      async (session) => {
        await session.perform(() => Promise.resolve('decoded'));
        callbackReady.resolve(undefined);
        await returnCallback.promise;
        return 'must-not-escape';
      },
    );
    void result.then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      },
    );
    await callbackReady.promise;
    try {
      await vi.advanceTimersByTimeAsync(250);
      await watcherReadStarted.promise;
      returnCallback.resolve(undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(finished).toBe(false);
      releaseReadCleanup.resolve(undefined);
      await expect(result).rejects.toBe(failure);
      expect(vi.getTimerCount()).toBe(0);
      expect(getEventListeners(context.signal, 'abort')).toHaveLength(0);
    } finally {
      returnCallback.resolve(undefined);
      releaseReadCleanup.resolve(undefined);
      context.abort();
      await result.catch(() => undefined);
    }
  });

  it('aborts and joins a pending owner read on context shutdown without starting value work', async () => {
    const started = Promise.withResolvers<undefined>();
    const releaseCleanup = Promise.withResolvers<undefined>();
    const context = new AbortController();
    let finished = false;
    let readSignal: AbortSignal | undefined;
    const inspectOwner = vi.fn<InspectCoordinatorValueOwner>((input) => {
      readSignal = input.signal;
      started.resolve(undefined);
      return new Promise((_resolve, reject) => {
        input.signal.addEventListener(
          'abort',
          () => {
            void releaseCleanup.promise.then(() => {
              reject(abortError(input.signal));
            });
          },
          { once: true },
        );
      });
    });
    const operation = vi.fn().mockResolvedValue('must-not-start');
    const lifetime = createCoordinatorValueWorkLifetime({
      policy: COORDINATOR_VALUE_WORK_POLICY_DEFAULTS,
      inspectOwner,
    });
    const result = lifetime
      .withValueWork(owner, context.signal, (session) =>
        session.perform(operation),
      )
      .then((outcome) => {
        finished = true;
        return outcome;
      });
    await started.promise;
    context.abort();
    expect(readSignal?.aborted).toBe(true);
    expect(finished).toBe(false);
    releaseCleanup.resolve(undefined);
    await expect(result).resolves.toEqual({
      kind: 'stopped',
      stop: { kind: 'context_aborted' },
    });
    expect(operation).not.toHaveBeenCalled();
    expect(getEventListeners(context.signal, 'abort')).toHaveLength(0);
  });
  it('fails closed without an owner inspector and rejects a session used after its scope', async () => {
    const operation = vi.fn().mockResolvedValue('must-not-start');
    const lifetime = createCoordinatorValueWorkLifetime({
      policy: COORDINATOR_VALUE_WORK_POLICY_DEFAULTS,
    });
    let captured: CoordinatorValueWorkSession | undefined;
    await expect(
      lifetime.withValueWork(owner, signal(), (session) => {
        captured = session;
        return session.perform(operation);
      }),
    ).resolves.toEqual({
      kind: 'stopped',
      stop: { kind: 'unavailable', reason: 'control_read_failed' },
    });
    expect(operation).not.toHaveBeenCalled();
    if (captured === undefined) throw new Error('Missing scoped session');
    await expect(captured.perform(operation)).rejects.toThrow('closed');
    expect(operation).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'canceled' },
    { kind: 'timed_out' },
    { kind: 'stale', revision: 5 },
    { kind: 'context_aborted' },
    { kind: 'unavailable', reason: 'control_read_failed' },
  ] as const)(
    'never starts preparation after actual owner stop %j',
    async (stop) => {
      const inspectOwner = vi.fn().mockResolvedValue({ kind: 'stopped', stop });
      const operation = vi.fn().mockResolvedValue('must-not-start');
      const context = new AbortController();
      const lifetime = createCoordinatorValueWorkLifetime({
        policy: COORDINATOR_VALUE_WORK_POLICY_DEFAULTS,
        inspectOwner,
      });
      await expect(
        lifetime.withValueWork(owner, context.signal, (session) =>
          session.perform(operation),
        ),
      ).resolves.toEqual({ kind: 'stopped', stop });
      expect(operation).not.toHaveBeenCalled();
      expect(getEventListeners(context.signal, 'abort')).toHaveLength(0);
    },
  );

  it.each([
    ['controlPollMillis', 99],
    ['controlPollMillis', 1_001],
    ['controlReadTimeoutMillis', 99],
    ['controlReadTimeoutMillis', 5_001],
    ['operationTimeoutMillis', 999],
    ['operationTimeoutMillis', 60_001],
    ['operationTimeoutMillis', Number.NaN],
    ['controlPollMillis', 250.5],
  ] as const)('refuses inadmissible parsed policy %s=%s', (field, value) => {
    expect(() =>
      createCoordinatorValueWorkLifetime({
        policy: { ...COORDINATOR_VALUE_WORK_POLICY_DEFAULTS, [field]: value },
      }),
    ).toThrow('policy');
  });
  it('joins work started inside the callback even if the callback does not await its promise', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'],
    });
    const inspectOwner = vi.fn().mockResolvedValue(active);
    const lifetime = createCoordinatorValueWorkLifetime({
      policy: COORDINATOR_VALUE_WORK_POLICY_DEFAULTS,
      inspectOwner,
    });
    let finished = false;
    let operationFinished = false;
    const result = lifetime
      .withValueWork(owner, signal(), (session) => {
        void session
          .perform(async (workSignal) => {
            await waitForCancelableDelay(1_000, workSignal);
            operationFinished = true;
          })
          .catch(() => undefined);
        return Promise.resolve('callback-result');
      })
      .then((value) => {
        finished = true;
        return value;
      });
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toEqual({
      kind: 'completed',
      value: 'callback-result',
    });
    expect(operationFinished).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('never starts preparation when the actual deadline is already elapsed but the owner has not classified durable timeout', async () => {
    const inspectOwner = vi
      .fn()
      .mockResolvedValue({ ...active, deadlineAt: '2026-10-02T23:59:59.999Z' });
    const operation = vi.fn().mockResolvedValue('must-not-start');
    const lifetime = createCoordinatorValueWorkLifetime({
      policy: COORDINATOR_VALUE_WORK_POLICY_DEFAULTS,
      inspectOwner,
    });
    await expect(
      lifetime.withValueWork(owner, signal(), (session) =>
        session.perform(operation),
      ),
    ).resolves.toEqual({
      kind: 'stopped',
      stop: { kind: 'unavailable', reason: 'value_work_timeout' },
    });
    expect(operation).not.toHaveBeenCalled();
    expect(inspectOwner).toHaveBeenCalledTimes(2);
  });
  it.each([false, true])(
    'caps work by database deadline despite wall-clock jumps and only the owner can classify timeout (%s)',
    async (ownerExpired) => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'],
      });
      vi.setSystemTime(new Date('2040-01-01T00:00:00.000Z'));
      const inspectOwner = vi.fn(() =>
        Promise.resolve(
          ownerExpired && performance.now() >= 500
            ? { kind: 'stopped' as const, stop: { kind: 'timed_out' as const } }
            : { ...active, deadlineAt: '2026-10-03T00:00:00.500Z' },
        ),
      );
      const started = Promise.withResolvers<undefined>();
      let workSignal: AbortSignal | undefined;
      const context = new AbortController();
      const lifetime = createCoordinatorValueWorkLifetime({
        policy: COORDINATOR_VALUE_WORK_POLICY_DEFAULTS,
        inspectOwner,
      });
      const result = lifetime.withValueWork(owner, context.signal, (session) =>
        session.perform(async (operationSignal) => {
          workSignal = operationSignal;
          started.resolve(undefined);
          await waitForCancelableDelay(30_000, operationSignal);
        }),
      );
      await started.promise;
      try {
        await vi.advanceTimersByTimeAsync(499);
        expect(workSignal?.aborted).toBe(false);
        vi.setSystemTime(new Date('1990-01-01T00:00:00.000Z'));
        await vi.advanceTimersByTimeAsync(1);
        expect(workSignal?.aborted).toBe(true);
        await expect(result).resolves.toEqual({
          kind: 'stopped',
          stop: ownerExpired
            ? { kind: 'timed_out' }
            : { kind: 'unavailable', reason: 'value_work_timeout' },
        });
        expect(inspectOwner.mock.calls.length).toBeGreaterThanOrEqual(3);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        context.abort();
        await result;
      }
    },
  );
  it('uses one whole-scope budget rather than resetting thirty seconds for each source', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'],
    });
    const inspectOwner = vi.fn().mockResolvedValue(active);
    const firstStarted = Promise.withResolvers<undefined>();
    const secondStarted = Promise.withResolvers<undefined>();
    let secondSignal: AbortSignal | undefined;
    const context = new AbortController();
    const lifetime = createCoordinatorValueWorkLifetime({
      policy: COORDINATOR_VALUE_WORK_POLICY_DEFAULTS,
      inspectOwner,
    });
    const result = lifetime.withValueWork(
      owner,
      context.signal,
      async (session) => {
        await session.perform(async (workSignal) => {
          firstStarted.resolve(undefined);
          await waitForCancelableDelay(15_000, workSignal);
        });
        await session.perform((workSignal) => {
          secondSignal = workSignal;
          secondStarted.resolve(undefined);
          return new Promise<void>((_resolve, reject) => {
            workSignal.addEventListener(
              'abort',
              () => {
                reject(abortError(workSignal));
              },
              { once: true },
            );
          });
        });
      },
    );
    await firstStarted.promise;
    try {
      await vi.advanceTimersByTimeAsync(15_000);
      await secondStarted.promise;
      await vi.advanceTimersByTimeAsync(14_999);
      expect(secondSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(secondSignal?.aborted).toBe(true);
      await expect(result).resolves.toEqual({
        kind: 'stopped',
        stop: { kind: 'unavailable', reason: 'value_work_timeout' },
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      context.abort();
      await result;
    }
  });
  it('serializes watcher and step inspections without overlapping owner reads', async () => {
    vi.useFakeTimers();
    const releaseRead = Promise.withResolvers<undefined>();
    const finishWork = Promise.withResolvers<undefined>();
    const started = Promise.withResolvers<undefined>();
    let activeReads = 0;
    let maximumReads = 0;
    let calls = 0;
    const inspectOwner = vi.fn(async () => {
      activeReads += 1;
      maximumReads = Math.max(maximumReads, activeReads);
      calls += 1;
      try {
        if (calls === 2) await releaseRead.promise;
        return active;
      } finally {
        activeReads -= 1;
      }
    });
    const context = new AbortController();
    const lifetime = createCoordinatorValueWorkLifetime({
      policy: COORDINATOR_VALUE_WORK_POLICY_DEFAULTS,
      inspectOwner,
    });
    const result = lifetime.withValueWork(owner, context.signal, (session) =>
      session.perform(async () => {
        started.resolve(undefined);
        await finishWork.promise;
        return 'complete';
      }),
    );
    await started.promise;
    try {
      await vi.advanceTimersByTimeAsync(250);
      finishWork.resolve(undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(maximumReads).toBe(1);
      releaseRead.resolve(undefined);
      await expect(result).resolves.toEqual({
        kind: 'completed',
        value: 'complete',
      });
      expect(activeReads).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      finishWork.resolve(undefined);
      releaseRead.resolve(undefined);
      context.abort();
      await result;
    }
  });
  it('bounds the whole owner read and joins cancellation-aware read cleanup before returning unavailable', async () => {
    vi.useFakeTimers();
    const started = Promise.withResolvers<undefined>();
    const releaseCleanup = Promise.withResolvers<undefined>();
    let readSignal: AbortSignal | undefined;
    let done = false;
    const inspectOwner = vi.fn((input: { signal: AbortSignal }) => {
      readSignal = input.signal;
      started.resolve(undefined);
      return new Promise<typeof active>((_resolve, reject) => {
        input.signal.addEventListener(
          'abort',
          () => {
            void releaseCleanup.promise.then(() => {
              reject(abortError(input.signal));
            });
          },
          { once: true },
        );
      });
    });
    const valueWork = vi.fn().mockResolvedValue('must-not-start');
    const lifetime = createCoordinatorValueWorkLifetime({
      policy: COORDINATOR_VALUE_WORK_POLICY_DEFAULTS,
      inspectOwner,
    });
    const context = new AbortController();
    const result = lifetime
      .withValueWork(owner, context.signal, (session) =>
        session.perform(valueWork),
      )
      .then((outcome) => {
        done = true;
        return outcome;
      });
    await started.promise;
    try {
      await vi.advanceTimersByTimeAsync(2_000);
      expect(readSignal?.aborted).toBe(true);
      expect(done).toBe(false);
      expect(valueWork).not.toHaveBeenCalled();
      releaseCleanup.resolve(undefined);
      await expect(result).resolves.toEqual({
        kind: 'stopped',
        stop: { kind: 'unavailable', reason: 'control_read_failed' },
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      releaseCleanup.resolve(undefined);
      context.abort();
      await result;
    }
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not inspect or start a watcher for pure literal demand-stage selection', async () => {
    const inspectOwner = vi.fn();
    const lifetime = createCoordinatorValueWorkLifetime({
      policy: COORDINATOR_VALUE_WORK_POLICY_DEFAULTS,
      inspectOwner,
    });
    await expect(
      lifetime.withValueWork(owner, signal(), () => Promise.resolve('literal')),
    ).resolves.toEqual({ kind: 'completed', value: 'literal' });
    expect(inspectOwner).not.toHaveBeenCalled();
  });

  it('aborts a stalled preparation stream on watched cancellation and joins cleanup before returning', async () => {
    vi.useFakeTimers();
    const inspectOwner = vi
      .fn()
      .mockResolvedValueOnce(active)
      .mockResolvedValue({ kind: 'stopped', stop: { kind: 'canceled' } });
    const lifetime = createCoordinatorValueWorkLifetime({
      policy: COORDINATOR_VALUE_WORK_POLICY_DEFAULTS,
      inspectOwner,
    });
    const started = Promise.withResolvers<undefined>();
    const cleaned = Promise.withResolvers<undefined>();
    const releaseCleanup = Promise.withResolvers<undefined>();
    const source = new PassThrough();
    const destination = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    let finished = false;
    const result = lifetime
      .withValueWork(owner, signal(), (session) =>
        session.perform(async (workSignal) => {
          started.resolve(undefined);
          try {
            await pipeline(source, destination, { signal: workSignal });
          } finally {
            cleaned.resolve(undefined);
            await releaseCleanup.promise;
          }
        }),
      )
      .then((value) => {
        finished = true;
        return value;
      });
    await started.promise;
    await vi.advanceTimersByTimeAsync(250);
    await cleaned.promise;
    expect(source.destroyed).toBe(true);
    expect(destination.destroyed).toBe(true);
    expect(finished).toBe(false);
    releaseCleanup.resolve(undefined);
    await expect(result).resolves.toEqual({
      kind: 'stopped',
      stop: { kind: 'canceled' },
    });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('checks actual owner immediately before any value I/O and after each operation', async () => {
    const events: string[] = [];
    const inspectOwner = vi.fn<InspectCoordinatorValueOwner>(() => {
      events.push('inspect');
      return Promise.resolve(active);
    });
    const lifetime = createCoordinatorValueWorkLifetime({
      policy: COORDINATOR_VALUE_WORK_POLICY_DEFAULTS,
      inspectOwner,
    });
    await expect(
      lifetime.withValueWork(owner, signal(), async (session) => {
        await session.perform(() => {
          events.push('read');
          return Promise.resolve('one');
        });
        return await session.perform(() => {
          events.push('prepare');
          return Promise.resolve('two');
        });
      }),
    ).resolves.toEqual({ kind: 'completed', value: 'two' });
    expect(events).toEqual([
      'inspect',
      'read',
      'inspect',
      'inspect',
      'prepare',
      'inspect',
    ]);
    expect(inspectOwner.mock.calls[0]?.[0]).toMatchObject({
      owner,
      readTimeoutMillis: 2_000,
    });
  });
});
