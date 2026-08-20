import { describe, expect, it } from 'vitest';

import {
  streamRunEventFrames,
  type LiveRunEventNotification,
  type LiveRunEventSource,
  type LiveRunEventSubscription,
  type PersistedRunEvent,
  type PersistedRunEventReader,
  type SseRunEventFrame,
} from '../../src/executions/run-event-stream.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_RUN_ID = '44444444-4444-4444-8444-444444444444';

function event(sequence: number): PersistedRunEvent {
  return {
    createdAt: new Date(sequence * 1_000).toISOString(),
    payload: { sequence },
    sequence,
    type: 'run.progressed',
  };
}

class MutableReader implements PersistedRunEventReader {
  public readonly calls: number[] = [];
  public events: PersistedRunEvent[] = [];

  public readPage(input: {
    readonly afterSequence: number;
    readonly limit: number;
    readonly runId: string;
    readonly signal: AbortSignal;
    readonly workspaceId: string;
  }): Promise<readonly PersistedRunEvent[]> {
    this.calls.push(input.afterSequence);
    return Promise.resolve(
      this.events
        .filter((item) => item.sequence > input.afterSequence)
        .slice(0, input.limit),
    );
  }
}

class ControlledSubscription implements LiveRunEventSubscription {
  public closed = false;
  private readonly notifications: LiveRunEventNotification[] = [];
  private waiter: (() => void) | undefined;

  public close(): Promise<void> {
    this.closed = true;
    this.waiter?.();
    return Promise.resolve();
  }

  public push(notification: LiveRunEventNotification): void {
    this.notifications.push(notification);
    this.waiter?.();
    this.waiter = undefined;
  }

  public async *[Symbol.asyncIterator](): AsyncIterator<LiveRunEventNotification> {
    while (!this.closed) {
      const notification = this.notifications.shift();
      if (notification !== undefined) {
        yield notification;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}

function source(subscription: ControlledSubscription): LiveRunEventSource {
  return {
    subscribe: () => Promise.resolve(subscription),
  };
}

function ref(
  sequence: number,
  overrides: Partial<{
    readonly runId: string;
    readonly workspaceId: string;
  }> = {},
): LiveRunEventNotification {
  return {
    kind: 'event',
    runId: overrides.runId ?? RUN_ID,
    sequence,
    workspaceId: overrides.workspaceId ?? WORKSPACE_ID,
  };
}

async function nextWithTimeout<T>(
  iterator: AsyncIterator<T>,
): Promise<IteratorResult<T>> {
  return Promise.race([
    iterator.next(),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error('stream timed out'));
      }, 1_000);
    }),
  ]);
}

async function nextFrame(
  iterator: AsyncIterator<SseRunEventFrame>,
): Promise<SseRunEventFrame> {
  const result = await nextWithTimeout(iterator);
  if (result.done === true) throw new Error('stream ended before next frame');
  return result.value;
}

describe('run event SSE reconstruction', () => {
  it('subscribes before reading and closes the subscription on cancellation', async () => {
    const order: string[] = [];
    const subscription = new ControlledSubscription();
    const reader: PersistedRunEventReader = {
      readPage: () => {
        order.push('read');
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
    await new Promise((resolve) => setTimeout(resolve, 0));
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
    expect((await nextFrame(iterator)).id).toBe(2);
    expect((await nextFrame(iterator)).id).toBe(3);

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
    expect((await nextFrame(iterator)).id).toBe(2);
    expect((await nextFrame(iterator)).id).toBe(3);
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
    while (reader.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
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
});
