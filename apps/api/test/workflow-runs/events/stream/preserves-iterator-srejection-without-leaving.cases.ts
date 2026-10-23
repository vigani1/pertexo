import { expect, it, vi } from 'vitest';
import {
  streamRunEventFrames,
  type LiveRunEventNotification,
  type LiveRunEventSubscription,
} from '../../../../src/workflow-runs/events/stream.js';
import { WORKSPACE_ID, RUN_ID } from './fixture.js';

export function registerPreservesIteratorSRejectionWithoutLeaving(): void {
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
}
