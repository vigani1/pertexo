import { expect, it, vi } from 'vitest';
import {
  streamRunEventFrames,
  type LiveRunEventNotification,
  type LiveRunEventSource,
  type LiveRunEventSubscription,
  type PersistedRunEventReader,
  type SseRunEventFrame,
} from '../../../../src/workflow-runs/events/stream.js';
import {
  WORKSPACE_ID,
  RUN_ID,
  event,
  MutableReader,
  ControlledSubscription,
  source,
  nextFrame,
} from './fixture.js';

export function registerPreservesUndefinedReadRejectionTogetherSubscription(): void {
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
}
