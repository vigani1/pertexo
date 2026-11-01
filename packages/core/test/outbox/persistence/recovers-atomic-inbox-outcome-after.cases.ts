import {
  apiDatabase,
  apiUrl,
  checksumA,
  checksumB,
  workspaceA,
} from './fixture.js';
import { randomUUID } from 'node:crypto';
import { count, sql } from 'drizzle-orm';

import { expect, it } from 'vitest';
import {
  parseDatabaseConfig,
  createWorkspaceDatabase,
} from '@pertexo/database/platform';

import { consumeInboxMessage } from '../../../src/testing.js';

import { insertOutboxEvent } from '@pertexo/database/primitives';
import { outboxEvents } from '@pertexo/database/schema';
import { createPostgresCommitAckProxy } from '@pertexo/database/testing';

import { outboxInput } from './fixture.js';

export function registerRecoversAtomicInboxOutcomeAfter(): void {
  it('recovers an atomic inbox outcome after the COMMIT acknowledgement is lost', async () => {
    const proxy = await createPostgresCommitAckProxy(apiUrl);
    const proxiedDatabase = createWorkspaceDatabase(
      parseDatabaseConfig({ connectionString: proxy.url, max: 1 }),
    );
    const consumerName = 'commit-ack-proof';
    const normalMessageId = randomUUID();
    const rollbackMessageId = randomUUID();
    const lostAckMessageId = randomUUID();
    const normalAcceptanceId = randomUUID();
    const rollbackAcceptanceId = randomUUID();
    const lostAckAcceptanceId = randomUUID();
    const normalOutbox = outboxInput();
    const rollbackOutbox = outboxInput();
    const lostAckOutbox = outboxInput();
    let lostAckWorkCalls = 0;

    const consume = (
      messageId: string,
      acceptanceId: string,
      event: ReturnType<typeof outboxInput>,
      failBeforeCommit = false,
    ) =>
      consumeInboxMessage(proxiedDatabase, workspaceA, {
        message: { consumerName, messageId, payloadChecksum: checksumA },
        operation: async (transaction) => {
          if (messageId === lostAckMessageId) lostAckWorkCalls += 1;
          await insertOutboxEvent(transaction, event);
          await transaction.db.execute(sql`
            insert into app.queue_duplicate_probe_acceptances
              (id, workspace_id, acceptance_key, request_hash, outbox_event_id)
            values (
              ${acceptanceId},
              ${transaction.workspaceId},
              ${`commit-ack:${acceptanceId}`},
              ${checksumA},
              ${event.id}
            )
          `);
          if (failBeforeCommit) throw new Error('pre-commit control failure');
          return event.id;
        },
      });

    const inspect = async (
      acceptanceId: string,
      messageId: string,
      outboxId: string,
    ) =>
      apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
        const durable = await db.execute(sql`
          select
            (select count(*)::integer
               from app.queue_duplicate_probe_acceptances
              where id = ${acceptanceId}) acceptance_count,
            (select count(*)::integer
               from app.inbox_receipts
              where consumer_name = ${consumerName}
                and message_id = ${messageId}
                and completed_at is not null) completed_receipt_count,
            (select count(*)::integer
               from app.outbox_events
              where id = ${outboxId}) outbox_count
        `);
        return durable.rows[0];
      });

    try {
      await expect(
        consume(normalMessageId, normalAcceptanceId, normalOutbox),
      ).resolves.toEqual({ status: 'processed', value: normalOutbox.id });
      await expect(
        inspect(normalAcceptanceId, normalMessageId, normalOutbox.id),
      ).resolves.toEqual({
        acceptance_count: 1,
        completed_receipt_count: 1,
        outbox_count: 1,
      });

      await expect(
        consume(rollbackMessageId, rollbackAcceptanceId, rollbackOutbox, true),
      ).rejects.toThrow('pre-commit control failure');
      await expect(
        inspect(rollbackAcceptanceId, rollbackMessageId, rollbackOutbox.id),
      ).resolves.toEqual({
        acceptance_count: 0,
        completed_receipt_count: 0,
        outbox_count: 0,
      });
      await expect(
        consume(rollbackMessageId, rollbackAcceptanceId, rollbackOutbox),
      ).resolves.toEqual({ status: 'processed', value: rollbackOutbox.id });
      await expect(
        inspect(rollbackAcceptanceId, rollbackMessageId, rollbackOutbox.id),
      ).resolves.toEqual({
        acceptance_count: 1,
        completed_receipt_count: 1,
        outbox_count: 1,
      });

      const acknowledgementDropped = proxy.dropNextCommitAcknowledgement();
      const uncertain = consume(
        lostAckMessageId,
        lostAckAcceptanceId,
        lostAckOutbox,
      );
      const observedUncertain = uncertain.then(
        () => undefined,
        (error: unknown) => error,
      );
      await acknowledgementDropped;
      expect(await observedUncertain).toBeInstanceOf(Error);
      await expect(
        inspect(lostAckAcceptanceId, lostAckMessageId, lostAckOutbox.id),
      ).resolves.toEqual({
        acceptance_count: 1,
        completed_receipt_count: 1,
        outbox_count: 1,
      });

      await expect(
        consume(lostAckMessageId, lostAckAcceptanceId, lostAckOutbox),
      ).resolves.toEqual({ status: 'duplicate' });
      expect(lostAckWorkCalls).toBe(1);
      expect(proxy.droppedConnectionCount()).toBe(1);
      expect(proxy.connectionCount()).toBeGreaterThanOrEqual(2);
      await expect(
        inspect(lostAckAcceptanceId, lostAckMessageId, lostAckOutbox.id),
      ).resolves.toEqual({
        acceptance_count: 1,
        completed_receipt_count: 1,
        outbox_count: 1,
      });
      await proxiedDatabase.close();
      await proxy.close();
      expect(proxy.activeSocketCount()).toBe(0);
    } finally {
      await Promise.all([proxiedDatabase.close(), proxy.close()]);
    }
  });

  it('returns an existing acceptance for the same request hash and rejects key reuse', async () => {
    const acceptanceKey = `accept:${randomUUID()}`;
    const accept = async (requestHash: string): Promise<string> =>
      apiDatabase.withWorkspace(workspaceA, async (transaction) => {
        const acceptanceId = randomUUID();
        const claimed = await transaction.db.execute(sql`
          insert into app.queue_duplicate_probe_acceptances
            (id, workspace_id, acceptance_key, request_hash)
          values (
            ${acceptanceId},
            ${transaction.workspaceId},
            ${acceptanceKey},
            ${requestHash}
          )
          on conflict (workspace_id, acceptance_key) do nothing
          returning id
        `);
        if (claimed.rows.length === 0) {
          const existing = await transaction.db.execute(sql`
            select request_hash, outbox_event_id
            from app.queue_duplicate_probe_acceptances
            where workspace_id = ${transaction.workspaceId}
              and acceptance_key = ${acceptanceKey}
          `);
          const row = existing.rows[0];
          if (row?.request_hash !== requestHash) {
            throw new Error('idempotency.request_hash_mismatch');
          }
          if (typeof row.outbox_event_id !== 'string') {
            throw new Error('idempotency.acceptance_incomplete');
          }
          return row.outbox_event_id;
        }

        const eventInput = outboxInput();
        await insertOutboxEvent(transaction, eventInput);
        await transaction.db.execute(sql`
          update app.queue_duplicate_probe_acceptances
          set outbox_event_id = ${eventInput.id}
          where id = ${acceptanceId}
        `);
        return eventInput.id;
      });

    const first = await accept(checksumA);
    await expect(accept(checksumA)).resolves.toBe(first);
    await expect(accept(checksumB)).rejects.toThrow(
      'idempotency.request_hash_mismatch',
    );
    await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
      const rows = await db.execute(sql`
        select count(*)::integer as count
        from app.queue_duplicate_probe_acceptances
        where acceptance_key = ${acceptanceKey}
      `);
      expect(rows.rows[0]).toEqual({ count: 1 });
      expect(await db.select({ count: count() }).from(outboxEvents)).toEqual([
        { count: 1 },
      ]);
    });
  });
}
