import type {
  LiveRunEventNotification,
  LiveRunEventSource,
  LiveRunEventSubscription,
  PersistedRunEvent,
  PersistedRunEventReader,
  SseRunEventFrame,
} from '../../../../src/workflow-runs/events/stream.js';

export const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';

export const OTHER_WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';

export const RUN_ID = '33333333-3333-4333-8333-333333333333';

export const OTHER_RUN_ID = '44444444-4444-4444-8444-444444444444';

export function event(sequence: number): PersistedRunEvent {
  return {
    createdAt: new Date(sequence * 1_000).toISOString(),
    payload: { sequence },
    sequence,
    type: 'run.progressed',
  };
}

export class MutableReader implements PersistedRunEventReader {
  public readonly calls: number[] = [];
  public events: PersistedRunEvent[] = [];
  private callChanged = Promise.withResolvers<undefined>();

  public readPage(input: {
    readonly afterSequence: number;
    readonly limit: number;
    readonly runId: string;
    readonly signal: AbortSignal;
    readonly workspaceId: string;
  }): Promise<readonly PersistedRunEvent[]> {
    this.calls.push(input.afterSequence);
    this.callChanged.resolve(undefined);
    this.callChanged = Promise.withResolvers<undefined>();
    return Promise.resolve(
      this.events
        .filter((item) => item.sequence > input.afterSequence)
        .slice(0, input.limit),
    );
  }

  public async waitForCallCount(count: number): Promise<void> {
    while (this.calls.length < count) {
      const changed = this.callChanged.promise;
      if (this.calls.length >= count) return;
      await changed;
    }
  }
}

export class ControlledSubscription implements LiveRunEventSubscription {
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

export function source(
  subscription: ControlledSubscription,
): LiveRunEventSource {
  return {
    subscribe: () => Promise.resolve(subscription),
  };
}

export function ref(
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

export async function nextWithTimeout<T>(
  iterator: AsyncIterator<T>,
): Promise<IteratorResult<T>> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error('stream timed out'));
        }, 1_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export async function nextFrame(
  iterator: AsyncIterator<SseRunEventFrame>,
): Promise<SseRunEventFrame> {
  const result = await nextWithTimeout(iterator);
  if (result.done === true) throw new Error('stream ended before next frame');
  return result.value;
}
