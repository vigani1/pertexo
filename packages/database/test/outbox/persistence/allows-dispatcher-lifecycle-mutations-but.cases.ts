import {
  apiDatabase,
  dispatcher,
  dispatcherUrl,
  hasPostgresCode,
  operator,
  operatorReplica,
  workspaceA,
  workspaceB,
} from './fixture.js';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { expect, it } from 'vitest';

import { OperatorCommandConflictError } from '../../../src/operator/input.js';
import { insertOutboxEvent } from '../../../src/outbox/events.repository.js';
import { auditEvents, outboxEvents } from '../../../src/schema.js';

import { enabledJobNames, outboxInput } from './fixture.js';

export function registerAllowsDispatcherLifecycleMutationsBut(): void {
  it('allows dispatcher lifecycle mutations but rejects immutable event rewrites', async () => {
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
      leaseOwner: 'least-privilege-proof',
      leaseToken: randomUUID(),
      limit: 100,
      maxAttempts: 3,
    });
    const event = claimed.events.find(({ id }) => id === input.id);
    if (event === undefined) throw new Error('Expected a claimed outbox event');

    const dispatcherPool = new Pool({
      connectionString: dispatcherUrl,
      max: 1,
    });
    try {
      for (const statement of [
        'update app.outbox_events set workspace_id = $2 where id = $1',
        "update app.outbox_events set job_name = 'rewritten' where id = $1",
        'update app.outbox_events set payload = $2::jsonb where id = $1',
        'update app.outbox_events set created_at = clock_timestamp() where id = $1',
      ]) {
        let queryValues;
        if (statement.includes('$2')) {
          if (statement.includes('workspace_id')) {
            queryValues = [input.id, workspaceB];
          } else {
            queryValues = [input.id, JSON.stringify({ rewritten: true })];
          }
        } else {
          queryValues = [input.id];
        }
        const values = queryValues;
        await expect(dispatcherPool.query(statement, values)).rejects.toSatisfy(
          hasPostgresCode('42501'),
        );
      }
    } finally {
      await dispatcherPool.end();
    }

    await expect(
      dispatcher.releaseOrFail({
        id: event.id,
        leaseToken: event.leaseToken,
        errorCode: 'redis.unavailable',
        maxAttempts: 3,
        retryAt: new Date(0),
      }),
    ).resolves.toBe('retry_scheduled');
  });

  it('verifies the dedicated dispatcher grants and migration head', async () => {
    await expect(dispatcher.checkReadiness()).resolves.toBeUndefined();
  });

  it('dry-runs and exactly replays a durable failed-row redispatch command', async () => {
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
      leaseOwner: 'operator-proof',
      leaseToken: randomUUID(),
      limit: 1,
      maxAttempts: 1,
    });
    const event = claimed.events.find(({ id }) => id === input.id);
    if (event === undefined)
      throw new Error('Expected failed-row fixture claim');
    await expect(
      dispatcher.releaseOrFail({
        errorCode: 'redis.unavailable',
        id: event.id,
        leaseToken: event.leaseToken,
        maxAttempts: 1,
        retryAt: new Date(),
      }),
    ).resolves.toBe('failed');

    const commandId = randomUUID();
    const command = {
      actorRef: 'ci-test-operator',
      commandId,
      dryRun: true,
      outboxEventId: input.id,
      reason: 'prove bounded failed outbox redispatch',
      workspaceId: workspaceA,
    } as const;
    const concurrent = await Promise.all([
      operator.redispatchFailedOutbox(command),
      operatorReplica.redispatchFailedOutbox(command),
    ]);
    expect(concurrent.map(({ replayed }) => replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(concurrent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          commandId,
          outcome: 'would_redispatch',
          status: 'completed',
        }),
      ]),
    );
    await expect(
      operator.redispatchFailedOutbox({
        ...command,
        reason: 'conflicting reason',
      }),
    ).rejects.toBeInstanceOf(OperatorCommandConflictError);

    const failed = await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.select().from(outboxEvents).where(eq(outboxEvents.id, input.id)),
    );
    expect(failed[0]?.failedAt).toBeInstanceOf(Date);
    expect(failed[0]).toMatchObject({
      lastErrorCode: 'redis.unavailable',
      publishAttempts: 1,
    });
    await expect(
      operator.getCommand({
        actorRef: command.actorRef,
        commandId,
        reason: 'inspect dry-run result',
        workspaceId: workspaceA,
      }),
    ).resolves.toMatchObject({
      commandId,
      outcome: 'would_redispatch',
      priorErrorCode: 'redis.unavailable',
      priorPublishAttempts: 1,
    });
    await expect(
      operator.getCommand({
        actorRef: command.actorRef,
        commandId,
        reason: 'prove workspace-bound lookup',
        workspaceId: workspaceB,
      }),
    ).resolves.toBeNull();
    await expect(
      operator.redispatchFailedOutbox({
        ...command,
        reason: 'cross-workspace conflicting replay',
        workspaceId: workspaceB,
      }),
    ).rejects.toBeInstanceOf(OperatorCommandConflictError);
    await expect(
      operator.getCommand({
        actorRef: command.actorRef,
        commandId,
        reason: 'prove conflict cannot forge workspace binding',
        workspaceId: workspaceB,
      }),
    ).resolves.toBeNull();
    const audits = await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
      db
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(eq(auditEvents.requestId, commandId)),
    );
    expect(audits).toHaveLength(3);
  });
}
