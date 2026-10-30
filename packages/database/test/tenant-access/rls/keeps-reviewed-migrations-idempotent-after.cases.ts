import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';

import { expect, it } from 'vitest';
import { parseDatabaseConfig } from '../../../src/config.js';
import { createWorkspaceDatabase } from '../../../src/database.js';

import { migrateDatabase } from '../../../src/migrations.js';

import { rlsProbeRecords } from '../../../src/schema.js';

import {
  apiUrl,
  workspaceA,
  workspaceB,
  recordA,
  recordB,
  database,
  migrationConfig,
  expectPgCode,
} from './fixture.js';

export function registerKeepsReviewedMigrationsIdempotentAfter(): void {
  it('keeps reviewed migrations idempotent after reaching head', async () => {
    await expect(migrateDatabase(migrationConfig)).resolves.toEqual([]);
  });

  it('returns only rows from the active workspace even for an unfiltered query', async () => {
    const rows = await database.withWorkspace(workspaceA, async ({ db }) =>
      db.select().from(rlsProbeRecords),
    );

    expect(rows.some((row) => row.id === recordA)).toBe(true);
    expect(rows.some((row) => row.id === recordB)).toBe(false);
  });

  it('cannot read, update, or delete another workspace explicitly', async () => {
    await database.withWorkspace(workspaceA, async ({ db }) => {
      const read = await db
        .select()
        .from(rlsProbeRecords)
        .where(eq(rlsProbeRecords.id, recordB));
      const updated = await db
        .update(rlsProbeRecords)
        .set({ label: 'tampered' })
        .where(eq(rlsProbeRecords.id, recordB))
        .returning();
      const deleted = await db
        .delete(rlsProbeRecords)
        .where(eq(rlsProbeRecords.id, recordB))
        .returning();

      expect(read).toEqual([]);
      expect(updated).toEqual([]);
      expect(deleted).toEqual([]);
    });
  });

  it('rejects a write carrying another workspace ID', async () => {
    await expect(
      database.withWorkspace(workspaceA, async ({ db }) => {
        await db.insert(rlsProbeRecords).values({
          id: randomUUID(),
          workspaceId: workspaceB,
          label: 'cross-tenant-write',
        });
      }),
    ).rejects.toSatisfy(expectPgCode('42501'));
  });

  it('rolls back failed operations', async () => {
    const rolledBackId = randomUUID();
    await expect(
      database.withWorkspace(workspaceA, async ({ db, workspaceId }) => {
        await db.insert(rlsProbeRecords).values({
          id: rolledBackId,
          workspaceId,
          label: 'must-roll-back',
        });
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');

    const rows = await database.withWorkspace(workspaceA, async ({ db }) =>
      db
        .select()
        .from(rlsProbeRecords)
        .where(eq(rlsProbeRecords.id, rolledBackId)),
    );
    expect(rows).toEqual([]);
  });

  it('does not leak context when one pooled connection changes workspaces', async () => {
    const aRows = await database.withWorkspace(workspaceA, async ({ db }) =>
      db.select().from(rlsProbeRecords),
    );
    const bRows = await database.withWorkspace(workspaceB, async ({ db }) =>
      db.select().from(rlsProbeRecords),
    );

    expect(aRows.some((row) => row.id === recordB)).toBe(false);
    expect(bRows.some((row) => row.id === recordA)).toBe(false);
  });

  it('cancels a blocked workspace query and destroys the pooled client', async () => {
    const controller = new AbortController();
    let queryStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      queryStarted = resolve;
    });
    const startedAt = Date.now();
    const pending = database.withWorkspace(
      workspaceA,
      async ({ db }) => {
        queryStarted();
        await db.execute(sql`select pg_sleep(30)`);
      },
      { signal: controller.signal },
    );

    await started;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - startedAt).toBeLessThan(2_000);

    await expect(
      database.withWorkspace(workspaceA, async ({ db }) => {
        const result = await db.execute<{ workspace_id: string }>(sql`
          select current_setting('app.workspace_id', true) as workspace_id
        `);
        return result.rows[0]?.workspace_id;
      }),
    ).resolves.toBe(workspaceA);
  });

  it('isolates concurrent workspace transactions sharing one pool', async () => {
    const concurrentDatabase = createWorkspaceDatabase(
      parseDatabaseConfig({
        connectionString: apiUrl,
        max: 2,
        ownerRole: 'pertexo_owner',
      }),
    );
    let arrivals = 0;
    let releaseBarrier: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    const readWorkspace = async (
      workspaceId: string,
    ): Promise<readonly string[]> =>
      concurrentDatabase.withWorkspace(workspaceId, async ({ db }) => {
        arrivals += 1;
        if (arrivals === 2) {
          releaseBarrier?.();
        }
        await barrier;
        const rows = await db.select().from(rlsProbeRecords);
        return rows.map((row) => row.id);
      });

    try {
      const [aIds, bIds] = await Promise.all([
        readWorkspace(workspaceA),
        readWorkspace(workspaceB),
      ]);
      expect(aIds).toContain(recordA);
      expect(aIds).not.toContain(recordB);
      expect(bIds).toContain(recordB);
      expect(bIds).not.toContain(recordA);
    } finally {
      releaseBarrier?.();
      await concurrentDatabase.close();
    }
  });

  it('drains the peer transaction when one participant fails before the barrier', async () => {
    const concurrentDatabase = createWorkspaceDatabase(
      parseDatabaseConfig({
        connectionString: apiUrl,
        max: 2,
        ownerRole: 'pertexo_owner',
      }),
    );
    const controller = new AbortController();
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const waiting = concurrentDatabase.withWorkspace(
      workspaceA,
      async () => barrier,
      { signal: controller.signal },
    );
    const failedParticipant = concurrentDatabase.withWorkspace(workspaceA, () =>
      Promise.reject(new Error('participant failed')),
    );

    try {
      await expect(failedParticipant).rejects.toThrow('participant failed');
    } finally {
      controller.abort();
      releaseBarrier();
      const outcomes = await Promise.allSettled([waiting, failedParticipant]);
      expect(outcomes.every(({ status }) => status === 'rejected')).toBe(true);
      await concurrentDatabase.close();
    }
  });
}
