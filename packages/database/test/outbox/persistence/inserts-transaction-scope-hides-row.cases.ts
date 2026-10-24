import {
  apiDatabase,
  apiUrl,
  checksumA,
  hasPostgresCode,
  workspaceA,
  workspaceB,
} from './fixture.js';
import { randomUUID } from 'node:crypto';
import { count, eq, sql } from 'drizzle-orm';

import { expect, it } from 'vitest';

import { insertOutboxEvent } from '../../../src/outbox/events.repository.js';
import { outboxEvents } from '../../../src/schema.js';

import {
  readQ11DatabaseIdentity,
  recordQ11Operation,
  waitForQ11OverlapBarrier,
} from '../../support/q11-benchmark.js';
import { outboxInput } from './fixture.js';

export function registerInsertsTransactionScopeHidesRow(): void {
  it('inserts with transaction scope and hides the row from another workspace', async () => {
    const input = outboxInput();
    await apiDatabase.withWorkspace(workspaceA, async (transaction) => {
      await insertOutboxEvent(transaction, input);
    });

    const visible = await apiDatabase.withWorkspace(
      workspaceA,
      async ({ db }) =>
        db.select().from(outboxEvents).where(eq(outboxEvents.id, input.id)),
    );
    const hidden = await apiDatabase.withWorkspace(workspaceB, async ({ db }) =>
      db.select().from(outboxEvents).where(eq(outboxEvents.id, input.id)),
    );
    expect(visible).toHaveLength(1);
    expect(hidden).toEqual([]);
  });

  it('enforces the 4 KiB payload cap in PostgreSQL when the helper is bypassed', async () => {
    await expect(
      apiDatabase.withWorkspace(workspaceA, async ({ db, workspaceId }) => {
        await db.insert(outboxEvents).values({
          id: randomUUID(),
          workspaceId,
          jobName: 'phase0-duplicate-proof',
          aggregateType: 'queue-proof',
          aggregateId: randomUUID(),
          payload: { value: 'x'.repeat(4_096) },
          payloadChecksum: checksumA,
        });
      }),
    ).rejects.toSatisfy(hasPostgresCode('23514'));
  });

  it('commits and rolls back domain acceptance with its outbox event', async () => {
    const acceptanceId = randomUUID();
    const eventInput = outboxInput();
    const accept = async (
      shouldFail: boolean,
      acceptedId = acceptanceId,
      acceptedEvent = eventInput,
    ): Promise<void> =>
      apiDatabase.withWorkspace(workspaceA, async (transaction) => {
        await insertOutboxEvent(transaction, acceptedEvent);
        await transaction.db.execute(sql`
          insert into app.queue_duplicate_probe_acceptances
            (id, workspace_id, acceptance_key, request_hash, outbox_event_id)
          values (
            ${acceptedId},
            ${transaction.workspaceId},
            ${`accept:${acceptedId}`},
            ${checksumA},
            ${acceptedEvent.id}
          )
        `);
        if (shouldFail) throw new Error('injected acceptance failure');
      });

    await expect(accept(true)).rejects.toThrow('injected acceptance failure');
    await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
      const acceptanceCount = await db.execute(sql`
        select count(*)::integer as count
        from app.queue_duplicate_probe_acceptances
      `);
      const outboxCount = await db
        .select({ count: count() })
        .from(outboxEvents);
      expect(acceptanceCount.rows[0]).toEqual({ count: 0 });
      expect(outboxCount).toEqual([{ count: 0 }]);
    });

    await waitForQ11OverlapBarrier();
    const databaseIdentity = await readQ11DatabaseIdentity(apiUrl);
    const operationPopulation =
      process.env.PERTEXO_Q11_OPERATION_TIMING === '1' ? 32 : 1;
    const operationStartedAt = performance.now();
    await expect(
      Promise.all(
        Array.from({ length: operationPopulation }, (_, index) =>
          index === 0
            ? accept(false)
            : accept(false, randomUUID(), outboxInput()),
        ),
      ),
    ).resolves.toHaveLength(operationPopulation);
    recordQ11Operation('foreground-acceptance', operationStartedAt, {
      population: operationPopulation,
      boundary:
        'concurrent real-role acceptance transactions through durable commit',
      databaseIdentity: databaseIdentity,
    });
    await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
      const acceptanceCount = await db.execute(sql`
        select count(*)::integer as count
        from app.queue_duplicate_probe_acceptances
      `);
      const outboxCount = await db
        .select({ count: count() })
        .from(outboxEvents);
      expect(acceptanceCount.rows[0]).toEqual({ count: operationPopulation });
      expect(outboxCount).toEqual([{ count: operationPopulation }]);
    });
  });
}
