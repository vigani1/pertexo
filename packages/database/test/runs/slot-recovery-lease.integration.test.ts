import { randomUUID } from 'node:crypto';
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { expect, it } from 'vitest';
import {
  migrateDatabase,
  MIGRATIONS_DIRECTORY,
} from '../../src/migrations/migrate-database.js';
import { withDatabase } from '../platform/migrations/upgrade-fixture.js';

const LEASE_MIGRATION = '0005_name_slot_recovery_lease.sql';
const FIVE_MINUTES_MS = 5 * 60 * 1_000;

/** Arms a bare reservation and returns its lease measured against the clock around the write. */
async function armedLease(admin: Pool) {
  const client = await admin.connect();
  try {
    await client.query('begin');
    // Only the lease writer is measured, so the reservation's neighbours are not seeded.
    await client.query("set local session_replication_role='replica'");
    const workspaceId = randomUUID(),
      outboxEventId = randomUUID();
    await client.query(
      'insert into app.workflow_run_active_admissions(workspace_id,workflow_run_id,outbox_event_id) values($1,$2,$3)',
      [workspaceId, randomUUID(), outboxEventId],
    );
    const before = await client.query<{ now: Date }>(
      'select clock_timestamp() now',
    );
    await client.query(
      'select app.arm_dispatcher_workflow_run_active_admission($1,$2)',
      [workspaceId, outboxEventId],
    );
    const after = await client.query<{ now: Date; recover_after: Date }>(
      'select clock_timestamp() now,recover_after from app.workflow_run_active_admissions where outbox_event_id=$1',
      [outboxEventId],
    );
    await client.query('rollback');
    const armed = after.rows[0],
      start = before.rows[0];
    if (armed === undefined || start === undefined)
      throw new Error('The reservation was not armed');
    return {
      earliest: start.now.getTime() + FIVE_MINUTES_MS,
      leaseEnd: armed.recover_after.getTime(),
      latest: armed.now.getTime() + FIVE_MINUTES_MS,
    };
  } finally {
    client.release();
  }
}

it('arms the same five-minute recovery lease before and after the lease gets one definition', async () => {
  await withDatabase(
    async ({ admin, config, directory }) => {
      for (const name of [
        '0000_baseline.sql',
        '0001_ordinary_run_history.sql',
        '0002_queue_head_admission.sql',
        '0003_ordered_start_wakeup.sql',
        '0004_widen_replay_safe_error_code.sql',
      ])
        await copyFile(join(MIGRATIONS_DIRECTORY, name), join(directory, name));
      await migrateDatabase(config, directory);
      const before = await armedLease(admin);
      expect(before.leaseEnd).toBeGreaterThanOrEqual(before.earliest);
      expect(before.leaseEnd).toBeLessThanOrEqual(before.latest);

      await copyFile(
        join(MIGRATIONS_DIRECTORY, LEASE_MIGRATION),
        join(directory, LEASE_MIGRATION),
      );
      await migrateDatabase(config, directory);
      const after = await armedLease(admin);
      expect(after.leaseEnd).toBeGreaterThanOrEqual(after.earliest);
      expect(after.leaseEnd).toBeLessThanOrEqual(after.latest);

      const lease = await admin.query<{ minutes: number }>(
        'select extract(epoch from app.workflow_run_slot_recovery_lease())/60 minutes',
      );
      expect(Number(lease.rows[0]?.minutes)).toBe(5);
      // Every reservation writer reads the one definition; none writes the interval itself.
      const writers = await admin.query<{ name: string }>(
        `select p.proname name from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname='app' and p.prosrc ilike '%5 minutes%' order by 1`,
      );
      expect(writers.rows.map((row) => row.name)).toEqual([
        'workflow_run_slot_recovery_lease',
      ]);
    },
    { migrate: false },
  );
});
