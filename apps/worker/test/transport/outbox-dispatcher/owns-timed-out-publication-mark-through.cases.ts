import { transportMetrics } from '../../support/transport/metrics.js';
import type { LeasedOutboxEvent } from '@pertexo/core/testing';

import { expect, it, vi } from 'vitest';

import { WorkerDrainState } from '../../../src/runtime/shutdown/drain-state.js';
import {
  EVENT_ID,
  LEASE_TOKEN,
  WORKSPACE_ID,
  indexedEvent,
  event,
  boundaries,
  createDispatcher,
} from './fixture.js';

export function registerOwnsTimedOutPublicationMarkThrough(): void {
  it.each([
    { kind: 'success', late: true },
    { kind: 'stale', late: false },
    { kind: 'rejection', late: new Error('late mark failed') },
  ] as const)(
    'owns a timed-out publication mark through late $kind settlement',
    async ({ late }) => {
      vi.useFakeTimers();
      const selected = boundaries();
      const mark = Promise.withResolvers<boolean>();
      vi.mocked(selected.database.markPublished).mockReturnValue(mark.promise);
      const dispatcher = createDispatcher({
        boundaries: selected,
        drainState: new WorkerDrainState(),
        metrics: transportMetrics(),
        operationTimeoutMillis: 100,
      });

      const dispatch = dispatcher.dispatchOnce();
      await vi.advanceTimersByTimeAsync(100);
      await expect(dispatch).resolves.toMatchObject({ outcomeUnknown: 1 });
      const closing = dispatcher.close();
      await Promise.resolve();
      expect(selected.database.close).not.toHaveBeenCalled();

      if (late instanceof Error) mark.reject(late);
      else mark.resolve(late);
      await expect(closing).resolves.toBeUndefined();
      expect(selected.database.markPublished).toHaveBeenCalledWith(
        EVENT_ID,
        LEASE_TOKEN,
      );
      expect(selected.database.releaseOrFail).not.toHaveBeenCalled();
    },
  );

  it('observes queue metrics only for enabled dispatch capabilities', async () => {
    const selected = boundaries([]);
    vi.mocked(selected.producer.observe).mockResolvedValue([
      {
        depth: 3,
        oldestJobAgeSeconds: 2,
        queueName: 'workflow-coordinator',
      },
      {
        depth: 99,
        oldestJobAgeSeconds: 90,
        queueName: 'maintenance',
      },
    ]);
    const metrics = transportMetrics();

    await createDispatcher({
      boundaries: selected,
      drainState: new WorkerDrainState(),
      metrics: metrics,
    }).dispatchOnce();

    expect(metrics.observeQueue).toHaveBeenCalledOnce();
    expect(metrics.observeQueue).toHaveBeenCalledWith({
      depth: 3,
      oldestJobAgeSeconds: 2,
      queueName: 'workflow-coordinator',
    });
  });

  it('samples workspace capacity after durable workflow publication', async () => {
    const selected = boundaries([event()]);
    const observeWorkspaceCapacity = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createDispatcher({ boundaries: selected });
    dispatcher.configureRuntimeHooks({ observeWorkspaceCapacity });

    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
      published: 1,
    });
    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
      published: 1,
    });
    expect(observeWorkspaceCapacity).toHaveBeenCalledOnce();
    expect(observeWorkspaceCapacity.mock.calls[0]?.[0]).toBe(WORKSPACE_ID);
    expect(observeWorkspaceCapacity.mock.calls[0]?.[1]).toBeInstanceOf(
      AbortSignal,
    );
  });

  it('does not block durable publication on workspace capacity sampling', async () => {
    const selected = boundaries([event()]);
    const sample = Promise.withResolvers<undefined>();
    const observeWorkspaceCapacity = vi.fn(() => sample.promise);
    const dispatcher = createDispatcher({ boundaries: selected });
    dispatcher.configureRuntimeHooks({ observeWorkspaceCapacity });

    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
      failed: 0,
      published: 1,
    });
    expect(observeWorkspaceCapacity).toHaveBeenCalledOnce();
    sample.resolve(undefined);
  });

  it('does not change durable publication when capacity sampling fails', async () => {
    const selected = boundaries([event()]);
    const dispatcher = createDispatcher({ boundaries: selected });
    dispatcher.configureRuntimeHooks({
      observeWorkspaceCapacity: vi
        .fn()
        .mockRejectedValue(new Error('metric query failed')),
    });

    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
      failed: 0,
      published: 1,
    });
  });

  it('bounds pending workspace capacity samples while one sample is in flight', async () => {
    const selected = boundaries([]);
    const batches = Array.from({ length: 11 }, (_, batch) =>
      Array.from({ length: batch === 10 ? 2 : 10 }, (_, offset) =>
        indexedEvent(batch * 10 + offset),
      ),
    );
    vi.mocked(selected.database.claimBatch).mockImplementation(() =>
      Promise.resolve({ events: batches.shift() ?? [] }),
    );
    const firstSample = Promise.withResolvers<undefined>();
    const observeWorkspaceCapacity = vi
      .fn<(workspaceId: string) => Promise<void>>()
      .mockImplementationOnce(() => firstSample.promise)
      .mockResolvedValue(undefined);
    const dispatcher = createDispatcher({ boundaries: selected });
    dispatcher.configureRuntimeHooks({ observeWorkspaceCapacity });

    for (let index = 0; index < 11; index += 1)
      await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
        published: index === 10 ? 2 : 10,
      });
    expect(observeWorkspaceCapacity).toHaveBeenCalledOnce();

    firstSample.resolve(undefined);
    await vi.waitFor(() => {
      expect(observeWorkspaceCapacity).toHaveBeenCalledTimes(101);
    });
    expect(observeWorkspaceCapacity).not.toHaveBeenCalledWith(
      indexedEvent(101).workspaceId,
    );
    await dispatcher.close();
  });

  it('evicts the oldest tracked workspace capacity sample at the tracking limit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T12:00:00.000Z'));
    const selected = boundaries([]);
    let claimedEvents: readonly LeasedOutboxEvent[] = [];
    vi.mocked(selected.database.claimBatch).mockImplementation(() =>
      Promise.resolve({ events: claimedEvents }),
    );
    const observeWorkspaceCapacity = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createDispatcher({ boundaries: selected });
    dispatcher.configureRuntimeHooks({ observeWorkspaceCapacity });

    for (let batch = 0; batch < 100; batch += 1) {
      claimedEvents = Array.from({ length: 10 }, (_, offset) =>
        indexedEvent(batch * 10 + offset),
      );
      await dispatcher.dispatchOnce();
      for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
      expect(observeWorkspaceCapacity).toHaveBeenCalledTimes((batch + 1) * 10);
    }

    claimedEvents = [indexedEvent(1_000)];
    await dispatcher.dispatchOnce();
    await vi.waitFor(() => {
      expect(observeWorkspaceCapacity).toHaveBeenCalledTimes(1_001);
    });

    claimedEvents = [indexedEvent(0), indexedEvent(500)];
    await dispatcher.dispatchOnce();
    await vi.waitFor(() => {
      expect(observeWorkspaceCapacity).toHaveBeenCalledTimes(1_002);
    });
    expect(observeWorkspaceCapacity.mock.calls.at(-1)?.[0]).toBe(
      indexedEvent(0).workspaceId,
    );
    await dispatcher.close();
  });

  it('drains an in-flight workspace capacity sample before closing boundaries', async () => {
    const selected = boundaries([event()]);
    const sample = Promise.withResolvers<undefined>();
    const dispatcher = createDispatcher({ boundaries: selected });
    dispatcher.configureRuntimeHooks({
      observeWorkspaceCapacity: vi.fn(() => sample.promise),
    });
    await dispatcher.dispatchOnce();

    const closing = dispatcher.close();
    await Promise.resolve();
    expect(selected.database.close).not.toHaveBeenCalled();
    expect(selected.producer.close).not.toHaveBeenCalled();

    sample.resolve(undefined);
    await expect(closing).resolves.toBeUndefined();
    expect(selected.database.close).toHaveBeenCalledOnce();
    expect(selected.producer.close).toHaveBeenCalledOnce();
  });
}
