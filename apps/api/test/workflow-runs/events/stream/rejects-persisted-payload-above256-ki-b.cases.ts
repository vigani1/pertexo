import { expect, it, vi } from 'vitest';
import {
  streamRunEventFrames,
  type LiveRunEventSubscription,
  type PersistedRunEvent,
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

export function registerRejectsPersistedPayloadAbove256KiB(): void {
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
}
