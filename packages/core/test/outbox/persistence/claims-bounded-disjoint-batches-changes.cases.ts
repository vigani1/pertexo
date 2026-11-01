import {
  apiDatabase,
  dispatcher,
  dispatcherUrl,
  workspaceA,
  workspaceB,
} from './fixture.js';
import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';
import { parseDatabaseConfig } from '@pertexo/database/platform';

import { createOutboxDispatcherDatabase } from '../../../src/outbox/dispatcher/repository.js';

import { insertOutboxEvent } from '@pertexo/database/primitives';

import { enabledJobNames, outboxInput } from './fixture.js';

export function registerClaimsBoundedDisjointBatchesChanges(): void {
  it('claims bounded disjoint batches and changes state only with the lease token', async () => {
    const ids: string[] = Array.from({ length: 4 }, () => randomUUID());
    await apiDatabase.withWorkspace(workspaceA, async (transaction) => {
      for (const id of ids) {
        await insertOutboxEvent(transaction, {
          ...outboxInput(id),
          availableAt: new Date(0),
        });
      }
    });
    const batches = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        dispatcher.claimBatch({
          enabledJobNames,
          leaseDurationMillis: 30_000,
          leaseOwner: `dispatcher-${String(index)}`,
          leaseToken: randomUUID(),
          limit: 2,
        }),
      ),
    );
    const claimed = batches
      .flatMap(({ events }) => events)
      .filter((event) => ids.includes(event.id));
    expect(new Set(claimed.map((event) => event.id)).size).toBe(4);
    const event = claimed[0];
    if (event === undefined) throw new Error('Expected a claimed outbox event');
    expect(event.availableAt).toBeInstanceOf(Date);
    expect(event.leaseExpiresAt).toBeInstanceOf(Date);
    expect(Object.isFrozen(event)).toBe(true);
    await expect(
      dispatcher.markPublished(event.id, randomUUID()),
    ).resolves.toBe(false);
    await expect(
      dispatcher.markPublished(event.id, event.leaseToken),
    ).resolves.toBe(true);
  });

  it('shares a batch equally between workspaces and gives a lone one all of it', async () => {
    const claim = (limit: number) =>
      dispatcher.claimBatch({
        enabledJobNames,
        leaseDurationMillis: 30_000,
        leaseOwner: 'share-proof',
        leaseToken: randomUUID(),
        limit,
      });
    const insert = async (workspaceId: string, count: number) => {
      await apiDatabase.withWorkspace(workspaceId, async (transaction) => {
        for (let index = 0; index < count; index += 1)
          await insertOutboxEvent(transaction, {
            ...outboxInput(randomUUID()),
            availableAt: new Date(0),
          });
      });
    };
    // Anything earlier cases left claimable would take a share.
    while ((await claim(100)).events.length > 0);

    await insert(workspaceA, 3);
    const alone = await claim(3);
    expect(alone.events.map(({ workspaceId }) => workspaceId)).toEqual([
      workspaceA,
      workspaceA,
      workspaceA,
    ]);

    await insert(workspaceA, 3);
    await insert(workspaceB, 3);
    const { events } = await claim(4);
    expect(
      events.filter(({ workspaceId }) => workspaceId === workspaceA),
    ).toHaveLength(2);
    expect(
      events.filter(({ workspaceId }) => workspaceId === workspaceB),
    ).toHaveLength(2);
  });

  it('never claims past the batch, and a busy workspace cannot crowd out a quiet one', async () => {
    const claim = (limit: number) =>
      dispatcher.claimBatch({
        enabledJobNames,
        leaseDurationMillis: 30_000,
        leaseOwner: 'share-bound-proof',
        leaseToken: randomUUID(),
        limit,
      });
    const insert = async (workspaceId: string, count: number) => {
      await apiDatabase.withWorkspace(workspaceId, async (transaction) => {
        for (let index = 0; index < count; index += 1)
          await insertOutboxEvent(transaction, {
            ...outboxInput(randomUUID()),
            availableAt: new Date(0),
          });
      });
    };
    while ((await claim(100)).events.length > 0);

    // Twenty waiting in one, one in the other, and a batch that doesn't divide evenly.
    await insert(workspaceA, 20);
    await insert(workspaceB, 1);
    const { events } = await claim(5);

    expect(events.length).toBeLessThanOrEqual(5);
    expect(
      events.filter(({ workspaceId }) => workspaceId === workspaceB),
    ).toHaveLength(1);
    expect(
      events.filter(({ workspaceId }) => workspaceId === workspaceA).length,
    ).toBeGreaterThan(1);
    while ((await claim(100)).events.length > 0);

    // Both busy, so an uneven share has nowhere to fall but past the limit.
    await insert(workspaceA, 5);
    await insert(workspaceB, 5);
    expect((await claim(5)).events.length).toBeLessThanOrEqual(5);
    while ((await claim(100)).events.length > 0);
  });

  it('persists fair workspace rotation across dispatcher process replacement', async () => {
    for (const workspaceId of [workspaceA, workspaceB]) {
      await apiDatabase.withWorkspace(workspaceId, async (transaction) => {
        for (let index = 0; index < 2; index += 1)
          await insertOutboxEvent(transaction, {
            ...outboxInput(),
            availableAt: new Date(0),
          });
      });
    }
    const claim = (
      database: ReturnType<typeof createOutboxDispatcherDatabase>,
    ) =>
      database.claimBatch({
        enabledJobNames,
        leaseDurationMillis: 30_000,
        leaseOwner: 'restart-fairness',
        leaseToken: randomUUID(),
        limit: 1,
      });
    const firstProcess = createOutboxDispatcherDatabase(
      parseDatabaseConfig({ connectionString: dispatcherUrl, max: 1 }),
    );
    const first = await claim(firstProcess);
    await firstProcess.close();
    const secondProcess = createOutboxDispatcherDatabase(
      parseDatabaseConfig({ connectionString: dispatcherUrl, max: 1 }),
    );
    try {
      const second = await claim(secondProcess);
      expect(first.events).toHaveLength(1);
      expect(second.events).toHaveLength(1);
      expect(second.events[0]?.workspaceId).not.toBe(
        first.events[0]?.workspaceId,
      );
    } finally {
      await secondProcess.close();
    }
  });

  it('observes only due and currently claimable outbox backlog', async () => {
    const dueId = randomUUID();
    await apiDatabase.withWorkspace(workspaceA, async (transaction) => {
      await insertOutboxEvent(transaction, {
        ...outboxInput(dueId),
        availableAt: new Date(Date.now() - 2_000),
      });
      await insertOutboxEvent(transaction, {
        ...outboxInput(),
        availableAt: new Date(Date.now() + 60_000),
      });
    });

    const due = await dispatcher.observeBacklog({ enabledJobNames });
    expect(due.backlog).toBe(1);
    expect(due.oldestAgeSeconds).toBeGreaterThanOrEqual(1);

    await dispatcher.claimBatch({
      enabledJobNames,
      leaseDurationMillis: 30_000,
      leaseOwner: 'observer-proof',
      leaseToken: randomUUID(),
      limit: 1,
    });
    await expect(
      dispatcher.observeBacklog({ enabledJobNames }),
    ).resolves.toEqual({ backlog: 0 });
  });
  it('schedules a retry only for the current lease and hides it until due', async () => {
    const id = randomUUID();
    await apiDatabase.withWorkspace(workspaceA, async (transaction) => {
      await insertOutboxEvent(transaction, {
        ...outboxInput(id),
        availableAt: new Date(0),
      });
    });
    const claimed = await dispatcher.claimBatch({
      enabledJobNames,
      leaseDurationMillis: 30_000,
      leaseOwner: 'retry-proof',
      leaseToken: randomUUID(),
      limit: 1,
    });
    const event = claimed.events.find((candidate) => candidate.id === id);
    if (event === undefined) throw new Error('Expected retry fixture claim');
    const retry = {
      id,
      leaseToken: event.leaseToken,
      disposition: 'retry' as const,
      retryAt: new Date(Date.now() + 60_000),
      errorCode: 'queue.unavailable',
    };
    await expect(
      dispatcher.releaseOrFail({ ...retry, leaseToken: randomUUID() }),
    ).resolves.toBe('not_leased');
    await expect(dispatcher.releaseOrFail(retry)).resolves.toBe(
      'retry_scheduled',
    );
    await expect(dispatcher.releaseOrFail(retry)).resolves.toBe('not_leased');
    await expect(dispatcher.markPublished(id, event.leaseToken)).resolves.toBe(
      false,
    );
    await expect(
      dispatcher.observeBacklog({ enabledJobNames }),
    ).resolves.toEqual({ backlog: 0 });
  });
}
