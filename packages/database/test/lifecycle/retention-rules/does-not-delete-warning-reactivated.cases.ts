import { Client, Pool } from 'pg';
import { expect, it } from 'vitest';
import { RETENTION_RULES } from '../../../src/lifecycle/retention/rules.js';
import {
  adminUrl,
  maintenanceUrl,
  withApplicationName,
  waitForPostgresLock,
  randomUUID,
  retention,
  withDatabase,
  workspaceId,
} from '../retention.support.js';
import {
  admin,
  enforceUntilIdle,
  insertRun,
  insertExecutionDetail,
  count,
} from './fixture.js';

export function registerDoesNotDeleteWarningReactivated(): void {
  it('does not delete a warning reactivated while its retention delete waits', async () => {
    const id = randomUUID();
    await admin.query(
      `insert into app.workspace_inbox_threads
        (workspace_id,id,notice_kind,subject_id,capacity_limit,active,source_revision,revision,occurrence_count,first_occurred_at,latest_occurred_at)
       values($1,$2,'limit_approaching',$2,'artifact_bytes',false,'artifact_bytes',nextval('app.workspace_inbox_revision_seq'),1,clock_timestamp()-interval '40 days',clock_timestamp()-interval '40 days')`,
      [workspaceId, id],
    );
    const rule = RETENTION_RULES.find(
      (candidate) => candidate.name === 'workspace_inbox_threads',
    );
    if (rule === undefined || !('run' in rule))
      throw new Error('Missing inbox retention rule');
    const applicationName = `retention-warning-${randomUUID()}`;
    const blocker = new Client({ connectionString: withDatabase(adminUrl) });
    const cleaner = new Pool({
      connectionString: withApplicationName(maintenanceUrl, applicationName),
    });
    await blocker.connect();
    let outcome: Promise<unknown> | undefined;
    try {
      await blocker.query('begin');
      await blocker.query(
        'update app.workspace_inbox_threads set active=true,latest_occurred_at=clock_timestamp() where id=$1',
        [id],
      );
      const client = await cleaner.connect();
      const pending = rule.run(client, 1000).finally(() => {
        client.release();
      });
      outcome = pending.catch((error: unknown) => error);
      await waitForPostgresLock(applicationName);
      await blocker.query('commit');
      expect(await pending).toBe(0);
      expect(
        (
          await admin.query(
            'select active from app.workspace_inbox_threads where id=$1',
            [id],
          )
        ).rows,
      ).toEqual([{ active: true }]);
    } finally {
      await blocker.query('rollback');
      await outcome;
      await cleaner.end();
      await blocker.end();
    }
  });

  it('skips a rule another worker is running', async () => {
    const old = await insertRun({ completedDaysAgo: 40 });
    await insertExecutionDetail(old);
    const index = RETENTION_RULES.findIndex(
      ({ name }) => name === 'run_events',
    );
    const holder = new Client({ connectionString: withDatabase(adminUrl) });
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query('select pg_advisory_xact_lock($1, $2)', [
        1_934_781_128,
        index,
      ]);
      const pass = await retention.enforce();
      expect(pass.removed.run_events).toBe(0);
      expect(pass.removed.node_runs).toBeGreaterThan(0);
      expect(await count('run_events', old)).toBe(1);
    } finally {
      await holder.query('rollback');
      await holder.end();
    }
    await enforceUntilIdle();
    expect(await count('run_events', old)).toBe(0);
  });
}
