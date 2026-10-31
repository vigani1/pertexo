import {
  apiDatabase,
  dispatcher,
  dispatcherUrl,
  migrationUrl,
  workspaceA,
} from './fixture.js';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { expect, it } from 'vitest';

import { insertOutboxEvent } from '../../../src/outbox/events.repository.js';
import { outboxEvents } from '../../../src/schema.js';

import { enabledJobNames, expireLease, outboxInput } from './fixture.js';

export function registerKeepsDisabledJobKindsDurable(): void {
  it('keeps disabled job kinds durable and unattempted while enabled work is claimable', async () => {
    const enabledId = randomUUID();
    const heldId = randomUUID();
    await apiDatabase.withWorkspace(workspaceA, async (transaction) => {
      await insertOutboxEvent(transaction, {
        ...outboxInput(enabledId),
        availableAt: new Date(0),
      });
      await insertOutboxEvent(transaction, {
        ...outboxInput(heldId),
        availableAt: new Date(0),
        jobName: 'reconcile-workflow-triggers',
      });
    });

    await expect(
      dispatcher.observeBacklog({ enabledJobNames }),
    ).resolves.toMatchObject({ backlog: 1 });
    const claimed = await dispatcher.claimBatch({
      enabledJobNames,
      leaseDurationMillis: 30_000,
      leaseOwner: 'allowlist-proof',
      leaseToken: randomUUID(),
      limit: 100,
    });
    expect(claimed.events.map((event) => event.id)).toContain(enabledId);
    expect(claimed.events.map((event) => event.id)).not.toContain(heldId);

    const held = await apiDatabase.withWorkspace(workspaceA, async ({ db }) =>
      db
        .select({
          failedAt: outboxEvents.failedAt,
          leaseExpiresAt: outboxEvents.leaseExpiresAt,
          leaseOwner: outboxEvents.leaseOwner,
          leaseToken: outboxEvents.leaseToken,
          publishAttempts: outboxEvents.publishAttempts,
          publishedAt: outboxEvents.publishedAt,
        })
        .from(outboxEvents)
        .where(eq(outboxEvents.id, heldId)),
    );
    expect(held).toEqual([
      {
        failedAt: null,
        leaseExpiresAt: null,
        leaseOwner: null,
        leaseToken: null,
        publishAttempts: 0,
        publishedAt: null,
      },
    ]);

    await apiDatabase.withWorkspace(workspaceA, ({ db }) =>
      db.execute(sql`
        with held_rows as (
          select gen_random_uuid() as id, gen_random_uuid() as aggregate_id
          from generate_series(1, 2000)
        )
        insert into app.outbox_events
          (id, workspace_id, job_name, aggregate_type,
           aggregate_id, payload, payload_checksum, available_at)
        select id, ${workspaceA}, 'reconcile-workflow-triggers',
          'workflow', aggregate_id,
          jsonb_build_object(
            'workspaceId', ${workspaceA}::uuid,
            'outboxEventId', id,
            'workflowId', aggregate_id,
            'publishedVersionId', aggregate_id
          ), repeat('0', 64), to_timestamp(0)
         from held_rows
      `),
    );
    const ownerPool = new Pool({ connectionString: migrationUrl, max: 1 });
    try {
      const owner = await ownerPool.connect();
      try {
        await owner.query('begin');
        await owner.query('set local role pertexo_owner');
        await owner.query('analyze app.outbox_events');
        await owner.query('commit');
      } catch (error: unknown) {
        await owner.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        owner.release();
      }
    } finally {
      await ownerPool.end();
    }

    const explainPool = new Pool({ connectionString: dispatcherUrl, max: 1 });
    try {
      await explainPool.query('set enable_seqscan = off');
      const plan = await explainPool.query<Record<string, unknown>>(
        `explain (format json, costs false)
         select id from app.outbox_events
         where published_at is null and failed_at is null
           and job_name = any($1::varchar[])
           and available_at <= clock_timestamp()
           and (lease_expires_at is null or lease_expires_at <= clock_timestamp())
         order by available_at, id limit 100`,
        [enabledJobNames],
      );
      expect(JSON.stringify(plan.rows)).toContain(
        'outbox_events_dispatch_job_due_idx',
      );
    } finally {
      await explainPool.end();
    }
  });

  it('reclaims expired leases and reaches an explicit attempt failure threshold', async () => {
    const id = randomUUID();
    await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      insertOutboxEvent(transaction, {
        ...outboxInput(id),
        availableAt: new Date(0),
      }).then(() => undefined),
    );
    const first = await dispatcher.claimBatch({
      enabledJobNames,
      leaseDurationMillis: 30_000,
      leaseOwner: 'dispatcher-a',
      leaseToken: randomUUID(),
      limit: 100,
    });
    const leased = first.events.find((event) => event.id === id);
    expect(leased?.publishAttempts).toBe(1);
    await expireLease(id);
    const second = await dispatcher.claimBatch({
      enabledJobNames,
      leaseDurationMillis: 30_000,
      leaseOwner: 'dispatcher-b',
      leaseToken: randomUUID(),
      limit: 100,
    });
    const reclaimed = second.events.find((event) => event.id === id);
    expect(reclaimed?.publishAttempts).toBe(2);
    if (reclaimed === undefined)
      throw new Error('Expected expired lease reclaim');
    await expect(
      dispatcher.releaseOrFail({
        id,
        leaseToken: reclaimed.leaseToken,
        errorCode: 'outbox.checksum_mismatch',
        disposition: 'fail',
      }),
    ).resolves.toBe('failed');
  });

  // backend-gaps-01: crash-only lease cycles used to end an event at a claim
  // limit, stranding its run; only a row that can never publish ends now.
  it('keeps claiming an event through any number of crash-only lease cycles', async () => {
    const id = randomUUID();
    await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      insertOutboxEvent(transaction, {
        ...outboxInput(id),
        availableAt: new Date(0),
      }).then(() => undefined),
    );

    for (const expectedAttempt of [1, 2, 3, 4]) {
      const claimed = await dispatcher.claimBatch({
        enabledJobNames,
        leaseDurationMillis: 30_000,
        leaseOwner: `crash-${String(expectedAttempt)}`,
        leaseToken: randomUUID(),
        limit: 100,
      });
      expect(
        claimed.events.find((event) => event.id === id)?.publishAttempts,
      ).toBe(expectedAttempt);
      await expireLease(id);
    }

    const row = await apiDatabase.withWorkspace(workspaceA, async ({ db }) =>
      db
        .select({ failedAt: outboxEvents.failedAt })
        .from(outboxEvents)
        .where(eq(outboxEvents.id, id)),
    );
    expect(row).toEqual([{ failedAt: null }]);
  });
}
