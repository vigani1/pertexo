import { describe, expect, it, vi } from 'vitest';
import {
  streamRunEventFrames,
  type LiveRunEventNotification,
  type LiveRunEventSubscription,
  type LiveRunEventSource,
  type PersistedRunEventReader,
  type SseRunEventFrame,
  type PersistedRunEvent,
} from '../../../src/workflow-runs/events/stream.js';
import {
  WORKSPACE_ID,
  RUN_ID,
  event,
  MutableReader,
  ControlledSubscription,
  source,
  nextFrame,
  OTHER_WORKSPACE_ID,
  OTHER_RUN_ID,
  ref,
  nextWithTimeout,
} from './stream.fixture.js';

describe('run event SSE reconstruction', () => {
  it.each([
    ['Error', new Error('iterator rejected')],
    ['string', 'iterator rejected'],
    ['undefined', undefined],
    ['null-prototype object', Object.create(null) as unknown],
    [
      'throwing coercion',
      {
        toString: () => {
          throw new Error('must not coerce iterator failure');
        },
      },
    ],
  ] as const)(
    'preserves an iterator %s rejection without leaving an abort observer',
    async (_label, failure) => {
      const close = vi.fn().mockResolvedValue(undefined);
      const returnIterator = vi
        .fn<() => Promise<IteratorResult<LiveRunEventNotification>>>()
        .mockResolvedValue({ done: true, value: undefined });
      const subscription: LiveRunEventSubscription = {
        close,
        [Symbol.asyncIterator]: () => ({
          next: () => {
            // Deliberately preserve arbitrary adapter rejection identity.
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            return Promise.reject(failure);
          },
          return: returnIterator,
        }),
      };
      const controller = new AbortController();
      const add = vi.spyOn(controller.signal, 'addEventListener');
      const remove = vi.spyOn(controller.signal, 'removeEventListener');
      const iterator = streamRunEventFrames(
        {
          lastEventId: 0,
          runId: RUN_ID,
          signal: controller.signal,
          workspaceId: WORKSPACE_ID,
        },
        {
          liveSource: { subscribe: () => Promise.resolve(subscription) },
          reader: { readPage: () => Promise.resolve([]) },
        },
      )[Symbol.asyncIterator]();

      const observed = await iterator.next().catch((error: unknown) => error);

      expect(observed).toBe(failure);
      expect(close).toHaveBeenCalledOnce();
      expect(returnIterator).toHaveBeenCalledOnce();
      expect(add).toHaveBeenCalledOnce();
      expect(remove).toHaveBeenCalledOnce();
    },
  );

  it('closes the subscription when its iterator factory or next call throws synchronously', async () => {
    const factoryFailure = new Error('iterator factory failed');
    const factoryClose = vi.fn().mockResolvedValue(undefined);
    const factoryIterator = streamRunEventFrames(
      {
        lastEventId: 0,
        runId: RUN_ID,
        signal: new AbortController().signal,
        workspaceId: WORKSPACE_ID,
      },
      {
        liveSource: {
          subscribe: () =>
            Promise.resolve({
              close: factoryClose,
              [Symbol.asyncIterator]: () => {
                throw factoryFailure;
              },
            }),
        },
        reader: { readPage: () => Promise.resolve([]) },
      },
    )[Symbol.asyncIterator]();
    await expect(factoryIterator.next()).rejects.toBe(factoryFailure);
    expect(factoryClose).toHaveBeenCalledOnce();

    const nextFailure = new Error('iterator next failed');
    const nextClose = vi.fn().mockResolvedValue(undefined);
    const returnIterator = vi.fn().mockResolvedValue({
      done: true as const,
      value: undefined,
    });
    const nextIterator = streamRunEventFrames(
      {
        lastEventId: 0,
        runId: RUN_ID,
        signal: new AbortController().signal,
        workspaceId: WORKSPACE_ID,
      },
      {
        liveSource: {
          subscribe: () =>
            Promise.resolve({
              close: nextClose,
              [Symbol.asyncIterator]: () => ({
                next: () => {
                  throw nextFailure;
                },
                return: returnIterator,
              }),
            }),
        },
        reader: { readPage: () => Promise.resolve([]) },
      },
    )[Symbol.asyncIterator]();
    await expect(nextIterator.next()).rejects.toBe(nextFailure);
    expect(nextClose).toHaveBeenCalledOnce();
    expect(returnIterator).toHaveBeenCalledOnce();
  });

  it.each(['resolve', 'reject'] as const)(
    'observes a pending iterator next that settles late after abort by %s',
    async (settlement) => {
      const deferred =
        Promise.withResolvers<IteratorResult<LiveRunEventNotification>>();
      const close = vi.fn().mockResolvedValue(undefined);
      const returnIterator = vi.fn().mockResolvedValue({
        done: true as const,
        value: undefined,
      });
      const next = vi.fn(() => deferred.promise);
      const subscription: LiveRunEventSubscription = {
        close,
        [Symbol.asyncIterator]: () => ({
          next,
          return: returnIterator,
        }),
      };
      const controller = new AbortController();
      const iterator = streamRunEventFrames(
        {
          lastEventId: 0,
          runId: RUN_ID,
          signal: controller.signal,
          workspaceId: WORKSPACE_ID,
        },
        {
          liveSource: { subscribe: () => Promise.resolve(subscription) },
          reader: { readPage: () => Promise.resolve([]) },
        },
      )[Symbol.asyncIterator]();
      const reading = iterator.next();
      await vi.waitFor(() => {
        expect(next).toHaveBeenCalledOnce();
      });

      controller.abort();
      await expect(reading).resolves.toEqual({ done: true, value: undefined });
      if (settlement === 'resolve') {
        deferred.resolve({ done: true, value: undefined });
      } else {
        // Deliberately prove the attached rejection observer survives abort.
        deferred.reject(undefined);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(close).toHaveBeenCalledOnce();
      expect(returnIterator).toHaveBeenCalledOnce();
    },
  );

  it('preserves a read failure together with subscription cleanup failure', async () => {
    const readError = new Error('read failed');
    const closeError = new Error('subscription close failed');
    const subscription: LiveRunEventSubscription = {
      close: () => Promise.reject(closeError),
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        for (const notification of [] as LiveRunEventNotification[])
          yield notification;
      },
    };
    const iterator = streamRunEventFrames(
      {
        lastEventId: 0,
        runId: RUN_ID,
        signal: new AbortController().signal,
        workspaceId: WORKSPACE_ID,
      },
      {
        liveSource: { subscribe: () => Promise.resolve(subscription) },
        reader: { readPage: () => Promise.reject(readError) },
      },
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([readError, closeError]);
      return true;
    });
  });

  it('preserves an undefined read rejection together with subscription cleanup failure', async () => {
    const closeError = new Error('subscription close failed');
    const subscription: LiveRunEventSubscription = {
      close: () => Promise.reject(closeError),
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        for (const notification of [] as LiveRunEventNotification[])
          yield notification;
      },
    };
    const iterator = streamRunEventFrames(
      {
        lastEventId: 0,
        runId: RUN_ID,
        signal: new AbortController().signal,
        workspaceId: WORKSPACE_ID,
      },
      {
        liveSource: { subscribe: () => Promise.resolve(subscription) },
        reader: {
          // Deliberately exercise a hostile non-Error adapter rejection.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          readPage: () => Promise.reject(undefined),
        },
      },
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([undefined, closeError]);
      return true;
    });
  });

  it('attempts every cleanup when synchronous failures follow a read failure', async () => {
    const readError = new Error('read failed');
    const closeError = new Error('subscription close failed synchronously');
    const returnError = new Error('iterator return failed synchronously');
    const close = vi.fn(() => {
      throw closeError;
    });
    const returnIterator = vi.fn(() => {
      throw returnError;
    });
    const pendingNext =
      Promise.withResolvers<IteratorResult<LiveRunEventNotification>>().promise;
    const subscription: LiveRunEventSubscription = {
      close,
      [Symbol.asyncIterator]: () => ({
        next: () => pendingNext,
        return: returnIterator,
      }),
    };
    const iterator = streamRunEventFrames(
      {
        lastEventId: 0,
        runId: RUN_ID,
        signal: new AbortController().signal,
        workspaceId: WORKSPACE_ID,
      },
      {
        liveSource: { subscribe: () => Promise.resolve(subscription) },
        reader: { readPage: () => Promise.reject(readError) },
      },
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([
        readError,
        closeError,
        returnError,
      ]);
      return true;
    });
    expect(close).toHaveBeenCalledOnce();
    expect(returnIterator).toHaveBeenCalledOnce();
  });

  it('attempts iterator return while subscription close remains nonsettling', async () => {
    const readError = new Error('read failed');
    const heldClose = Promise.withResolvers<undefined>();
    const close = vi.fn(() => heldClose.promise);
    const returnIterator = vi.fn().mockResolvedValue({
      done: true as const,
      value: undefined,
    });
    const subscription: LiveRunEventSubscription = {
      close,
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true, value: undefined }),
        return: returnIterator,
      }),
    };
    const iterator = streamRunEventFrames(
      {
        lastEventId: 0,
        runId: RUN_ID,
        signal: new AbortController().signal,
        workspaceId: WORKSPACE_ID,
      },
      {
        liveSource: { subscribe: () => Promise.resolve(subscription) },
        reader: { readPage: () => Promise.reject(readError) },
      },
    )[Symbol.asyncIterator]();
    const reading = iterator.next();

    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledOnce();
      expect(returnIterator).toHaveBeenCalledOnce();
    });
    heldClose.resolve(undefined);
    await expect(reading).rejects.toBe(readError);
  });

  it('subscribes before reading and closes the subscription on cancellation', async () => {
    const order: string[] = [];
    const readStarted = Promise.withResolvers<undefined>();
    const subscription = new ControlledSubscription();
    const reader: PersistedRunEventReader = {
      readPage: () => {
        order.push('read');
        readStarted.resolve(undefined);
        return Promise.resolve([]);
      },
    };
    const liveSource: LiveRunEventSource = {
      subscribe: () => {
        order.push('subscribe');
        return Promise.resolve(subscription);
      },
    };
    const controller = new AbortController();
    const iterator = streamRunEventFrames(
      {
        lastEventId: 0,
        runId: RUN_ID,
        signal: controller.signal,
        workspaceId: WORKSPACE_ID,
      },
      { liveSource, reader },
    )[Symbol.asyncIterator]();

    const pending = iterator.next();
    await readStarted.promise;
    expect(order.slice(0, 2)).toEqual(['subscribe', 'read']);

    controller.abort();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(subscription.closed).toBe(true);
  });

  it('backfills bounded pages after Last-Event-ID and emits canonical SSE frames', async () => {
    const reader = new MutableReader();
    reader.events = [event(1), event(2), event(3), event(4), event(5)];
    const subscription = new ControlledSubscription();
    const iterator = streamRunEventFrames(
      {
        lastEventId: 1,
        runId: RUN_ID,
        signal: new AbortController().signal,
        workspaceId: WORKSPACE_ID,
      },
      { liveSource: source(subscription), reader },
      { pageSize: 2 },
    )[Symbol.asyncIterator]();

    const frames: SseRunEventFrame[] = [];
    for (let index = 0; index < 4; index += 1) {
      frames.push(await nextFrame(iterator));
    }

    expect(frames.map((frame) => frame.id)).toEqual([2, 3, 4, 5]);
    expect(frames[0]).toEqual({
      data: JSON.stringify(event(2)),
      event: 'run.progressed',
      id: 2,
      visibilityPath: 'reconnect_backfill',
    });
    expect(reader.calls).toEqual([1, 3]);
    await iterator.return(undefined);
  });

  it('repairs gaps and suppresses duplicate live delivery from PostgreSQL', async () => {
    const reader = new MutableReader();
    reader.events = [event(1)];
    const subscription = new ControlledSubscription();
    const iterator = streamRunEventFrames(
      {
        lastEventId: 0,
        runId: RUN_ID,
        signal: new AbortController().signal,
        workspaceId: WORKSPACE_ID,
      },
      { liveSource: source(subscription), reader },
      { pageSize: 2 },
    )[Symbol.asyncIterator]();

    expect((await nextFrame(iterator)).id).toBe(1);
    reader.events.push(event(2), event(3));
    subscription.push(ref(3));
    const liveFirst = await nextFrame(iterator);
    const liveSecond = await nextFrame(iterator);
    expect(liveFirst.id).toBe(2);
    expect(liveFirst.visibilityPath).toBe('live_wakeup');
    expect(liveSecond.id).toBe(3);
    expect(liveSecond.visibilityPath).toBe('live_wakeup');

    subscription.push(ref(2));
    reader.events.push(event(4));
    subscription.push(ref(4));
    expect((await nextFrame(iterator)).id).toBe(4);
    await iterator.return(undefined);
  });

  it('backfills events committed during the subscribe/read race', async () => {
    const reader = new MutableReader();
    const subscription = new ControlledSubscription();
    const originalRead = reader.readPage.bind(reader);
    let first = true;
    reader.readPage = (input) => {
      if (first) {
        first = false;
        reader.events.push(event(1));
        subscription.push(ref(1));
      }
      return originalRead(input);
    };
    const iterator = streamRunEventFrames(
      {
        lastEventId: 0,
        runId: RUN_ID,
        signal: new AbortController().signal,
        workspaceId: WORKSPACE_ID,
      },
      { liveSource: source(subscription), reader },
    )[Symbol.asyncIterator]();

    expect((await nextFrame(iterator)).id).toBe(1);
    await iterator.return(undefined);
  });

  it('reconstructs all missed events after a Redis disconnect/reconnect signal', async () => {
    const reader = new MutableReader();
    reader.events = [event(1)];
    const subscription = new ControlledSubscription();
    const iterator = streamRunEventFrames(
      {
        lastEventId: 0,
        runId: RUN_ID,
        signal: new AbortController().signal,
        workspaceId: WORKSPACE_ID,
      },
      { liveSource: source(subscription), reader },
    )[Symbol.asyncIterator]();

    expect((await nextFrame(iterator)).id).toBe(1);
    reader.events.push(event(2), event(3));
    subscription.push({ kind: 'resync' });
    const recoveredFirst = await nextFrame(iterator);
    const recoveredSecond = await nextFrame(iterator);
    expect(recoveredFirst.id).toBe(2);
    expect(recoveredFirst.visibilityPath).toBe('recovery_backfill');
    expect(recoveredSecond.id).toBe(3);
    expect(recoveredSecond.visibilityPath).toBe('recovery_backfill');
    await iterator.return(undefined);
  });

  it('ignores malformed and cross-run live references without leaking events', async () => {
    const reader = new MutableReader();
    const subscription = new ControlledSubscription();
    const iterator = streamRunEventFrames(
      {
        lastEventId: 0,
        runId: RUN_ID,
        signal: new AbortController().signal,
        workspaceId: WORKSPACE_ID,
      },
      { liveSource: source(subscription), reader },
    )[Symbol.asyncIterator]();

    const pending = nextWithTimeout(iterator);
    await reader.waitForCallCount(1);
    subscription.push({
      kind: 'event',
      runId: 'not-a-uuid',
      sequence: -1,
      workspaceId: WORKSPACE_ID,
    });
    subscription.push(ref(1, { runId: OTHER_RUN_ID }));
    subscription.push(ref(1, { workspaceId: OTHER_WORKSPACE_ID }));
    reader.events.push(event(1));
    subscription.push(ref(1));

    await expect(pending).resolves.toMatchObject({ value: { id: 1 } });
    expect(reader.calls.filter((cursor) => cursor === 0)).toHaveLength(2);
    await iterator.return(undefined);
  });

  it('rejects an over-limit reader page before emitting and closes the subscription', async () => {
    const subscription = new ControlledSubscription();
    const iterator = streamRunEventFrames(
      {
        lastEventId: 0,
        runId: RUN_ID,
        signal: new AbortController().signal,
        workspaceId: WORKSPACE_ID,
      },
      {
        liveSource: source(subscription),
        reader: {
          readPage: () => Promise.resolve([event(1), event(2), event(3)]),
        },
      },
      { pageSize: 2 },
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toMatchObject({
      name: 'RunEventStreamInvariantError',
    });
    expect(subscription.closed).toBe(true);
  });

  it.each([
    ['hole', [event(1), event(3)]],
    ['duplicate', [event(1), event(1)]],
    ['out-of-order row', [event(2), event(1)]],
  ] as const)(
    'rejects a %s in a persisted page before emitting any row',
    async (_label, page) => {
      const subscription = new ControlledSubscription();
      const iterator = streamRunEventFrames(
        {
          lastEventId: 0,
          runId: RUN_ID,
          signal: new AbortController().signal,
          workspaceId: WORKSPACE_ID,
        },
        {
          liveSource: source(subscription),
          reader: { readPage: () => Promise.resolve(page) },
        },
      )[Symbol.asyncIterator]();

      await expect(iterator.next()).rejects.toMatchObject({
        name: 'RunEventStreamInvariantError',
      });
      expect(subscription.closed).toBe(true);
    },
  );

  it.each([
    ['event type', { ...event(1), type: 'INVALID TYPE' }],
    ['event time', { ...event(1), createdAt: 'not-a-time' }],
    ['event sequence', { ...event(1), sequence: 0 }],
  ] as const)(
    'rejects an invalid persisted %s before emission and closes resources',
    async (_label, invalidEvent) => {
      const subscription = new ControlledSubscription();
      const iterator = streamRunEventFrames(
        {
          lastEventId: 0,
          runId: RUN_ID,
          signal: new AbortController().signal,
          workspaceId: WORKSPACE_ID,
        },
        {
          liveSource: source(subscription),
          reader: { readPage: () => Promise.resolve([invalidEvent]) },
        },
      )[Symbol.asyncIterator]();

      await expect(iterator.next()).rejects.toBeDefined();
      expect(subscription.closed).toBe(true);
    },
  );

  it('rejects a persisted payload above the 256 KiB SSE bound', async () => {
    const subscription = new ControlledSubscription();
    const oversized = {
      ...event(1),
      payload: { value: 'x'.repeat(256 * 1_024) },
    };
    const iterator = streamRunEventFrames(
      {
        lastEventId: 0,
        runId: RUN_ID,
        signal: new AbortController().signal,
        workspaceId: WORKSPACE_ID,
      },
      {
        liveSource: source(subscription),
        reader: { readPage: () => Promise.resolve([oversized]) },
      },
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toMatchObject({
      name: 'RunEventStreamInvariantError',
    });
    expect(subscription.closed).toBe(true);
  });

  it('reads one more page after an exact page boundary', async () => {
    const reader = new MutableReader();
    reader.events = [event(1), event(2)];
    const subscription = new ControlledSubscription();
    const controller = new AbortController();
    const iterator = streamRunEventFrames(
      {
        lastEventId: 0,
        runId: RUN_ID,
        signal: controller.signal,
        workspaceId: WORKSPACE_ID,
      },
      { liveSource: source(subscription), reader },
      { pageSize: 2 },
    )[Symbol.asyncIterator]();

    expect((await nextFrame(iterator)).id).toBe(1);
    expect((await nextFrame(iterator)).id).toBe(2);
    const pending = iterator.next();
    await vi.waitFor(() => {
      expect(reader.calls).toEqual([0, 2]);
    });
    controller.abort();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
  });

  it('does not emit a page that resolves after cancellation', async () => {
    const read = Promise.withResolvers<readonly PersistedRunEvent[]>();
    const subscription = new ControlledSubscription();
    const controller = new AbortController();
    const reader = { readPage: vi.fn(() => read.promise) };
    const iterator = streamRunEventFrames(
      {
        lastEventId: 0,
        runId: RUN_ID,
        signal: controller.signal,
        workspaceId: WORKSPACE_ID,
      },
      { liveSource: source(subscription), reader },
    )[Symbol.asyncIterator]();
    const pending = iterator.next();
    await vi.waitFor(() => {
      expect(reader.readPage).toHaveBeenCalledOnce();
    });

    controller.abort();
    read.resolve([event(1)]);

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(subscription.closed).toBe(true);
  });

  it('closes resources when the live notification iterator is already closed', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const returnIterator = vi.fn().mockResolvedValue({
      done: true as const,
      value: undefined,
    });
    const subscription: LiveRunEventSubscription = {
      close,
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true, value: undefined }),
        return: returnIterator,
      }),
    };
    const iterator = streamRunEventFrames(
      {
        lastEventId: 0,
        runId: RUN_ID,
        signal: new AbortController().signal,
        workspaceId: WORKSPACE_ID,
      },
      {
        liveSource: { subscribe: () => Promise.resolve(subscription) },
        reader: { readPage: () => Promise.resolve([]) },
      },
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(close).toHaveBeenCalledOnce();
    expect(returnIterator).toHaveBeenCalledOnce();
  });
});
