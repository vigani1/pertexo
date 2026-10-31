import { apiDatabase, dispatcher, operator, workspaceA } from './fixture.js';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { expect, it } from 'vitest';

import { insertOutboxEvent } from '../../../src/outbox/events.repository.js';
import { outboxEvents } from '../../../src/schema.js';

import { enabledJobNames, outboxInput } from './fixture.js';

export function registerRedispatchesOneFailedRowWithout(): void {
  it('redispatches one failed row without changing immutable transport identity', async () => {
    const input = outboxInput();
    await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      insertOutboxEvent(transaction, {
        ...input,
        availableAt: new Date(0),
      }).then(() => undefined),
    );
    const claimed = await dispatcher.claimBatch({
      enabledJobNames,
      leaseDurationMillis: 30_000,
      leaseOwner: 'operator-execute-proof',
      leaseToken: randomUUID(),
      limit: 1,
    });
    const event = claimed.events.find(({ id }) => id === input.id);
    if (event === undefined)
      throw new Error('Expected failed-row fixture claim');
    await dispatcher.releaseOrFail({
      errorCode: 'redis.unavailable',
      id: event.id,
      leaseToken: event.leaseToken,
      disposition: 'fail',
    });

    const before = await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.select().from(outboxEvents).where(eq(outboxEvents.id, input.id)),
    );
    const commandId = randomUUID();
    await expect(
      operator.redispatchFailedOutbox({
        actorRef: 'ci-test-operator',
        commandId,
        dryRun: false,
        outboxEventId: input.id,
        reason: 'retry after queue recovery',
        workspaceId: workspaceA,
      }),
    ).resolves.toMatchObject({ outcome: 'redispatched', replayed: false });

    const after = await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.select().from(outboxEvents).where(eq(outboxEvents.id, input.id)),
    );
    expect(after[0]).toMatchObject({
      aggregateId: before[0]?.aggregateId,
      aggregateType: before[0]?.aggregateType,
      failedAt: null,
      id: before[0]?.id,
      jobName: before[0]?.jobName,
      lastErrorCode: null,
      payload: before[0]?.payload,
      payloadChecksum: before[0]?.payloadChecksum,
      publishAttempts: 0,
      publishedAt: null,
      workspaceId: before[0]?.workspaceId,
    });
    const reclaimed = await dispatcher.claimBatch({
      enabledJobNames,
      leaseDurationMillis: 30_000,
      leaseOwner: 'operator-normal-dispatch',
      leaseToken: randomUUID(),
      limit: 1,
    });
    expect(reclaimed.events.map(({ id }) => id)).toContain(input.id);
  });

  it('keeps the operator role function-only and on the expected migration head', async () => {
    await expect(operator.checkReadiness()).resolves.toBeUndefined();
  });
}
