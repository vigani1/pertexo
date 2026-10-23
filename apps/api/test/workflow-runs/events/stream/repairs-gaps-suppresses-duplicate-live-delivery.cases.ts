import { expect, it } from 'vitest';
import { streamRunEventFrames } from '../../../../src/workflow-runs/events/stream.js';
import {
  WORKSPACE_ID,
  OTHER_WORKSPACE_ID,
  RUN_ID,
  OTHER_RUN_ID,
  event,
  MutableReader,
  ControlledSubscription,
  source,
  ref,
  nextWithTimeout,
  nextFrame,
} from './fixture.js';

export function registerRepairsGapsSuppressesDuplicateLiveDelivery(): void {
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
}
