import { describe, expect, it } from 'vitest';

import {
  Pool,
  maintenanceUrl,
  owner,
  randomUUID,
  retention,
  userId,
} from './support/retention.integration.support.js';

describe('retention enforcement scheduling', () => {
  it('schedules bounded enforcement exactly once across concurrency and restart', async () => {
    const scheduledWorkspaceIds = Array.from({ length: 26 }, () =>
      randomUUID(),
    );
    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      await owner.query(
        `update app.retention_schedule_state
         set next_scan_at=clock_timestamp()+interval '1 day'`,
      );
      await owner.query(
        'alter table app.workflow_runs no force row level security',
      );
      for (const scheduledWorkspaceId of scheduledWorkspaceIds) {
        await owner.query("select set_config('app.workspace_id',$1,true)", [
          scheduledWorkspaceId,
        ]);
        await owner.query(
          `insert into app.workspaces(id,name,slug,created_by)
           values($1,'Scheduled retention',$2,$3)`,
          [
            scheduledWorkspaceId,
            `scheduled-retention-${scheduledWorkspaceId}`,
            userId,
          ],
        );
        await owner.query(
          `with observed as (select clock_timestamp() observed_at)
           insert into app.workflow_runs
             (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,
              input_ref,input_ref_expires_at,created_at,updated_at)
           select $1,$2,$3,$4,'manual','queued',$5::jsonb,
             observed_at-interval '1 day',observed_at-interval '31 days',
             observed_at-interval '31 days' from observed`,
          [
            randomUUID(),
            scheduledWorkspaceId,
            randomUUID(),
            randomUUID(),
            JSON.stringify({ kind: 'inline', schemaVersion: 1, value: 'due' }),
          ],
        );
      }
      await owner.query(
        'alter table app.workflow_runs force row level security',
      );
      await owner.query('commit');
    } catch (error: unknown) {
      await owner.query('rollback').catch(() => undefined);
      throw error;
    }

    const concurrent = await Promise.all(
      Array.from({ length: 6 }, () => retention.scheduleEnforcement()),
    );
    expect(
      concurrent.reduce((sum, result) => sum + result.scannedCount, 0),
    ).toBe(130);
    expect(
      concurrent.reduce((sum, result) => sum + result.scheduledCount, 0),
    ).toBe(26);
    expect(concurrent.every(({ cutoffAt }) => cutoffAt <= new Date())).toBe(
      true,
    );

    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      await owner.query(
        `update app.retention_schedule_state
         set next_scan_at=clock_timestamp()-interval '1 second'
         where workspace_id=any($1::uuid[])
           and retention_kind='workflow_run_input'`,
        [scheduledWorkspaceIds],
      );
      await owner.query('commit');
    } catch (error: unknown) {
      await owner.query('rollback').catch(() => undefined);
      throw error;
    }
    const restarted = await Promise.all([
      retention.scheduleEnforcement(),
      retention.scheduleEnforcement(),
    ]);
    expect(
      restarted.reduce((sum, result) => sum + result.scannedCount, 0),
    ).toBe(26);
    expect(
      restarted.reduce((sum, result) => sum + result.scheduledCount, 0),
    ).toBe(0);

    await owner.query('begin');
    try {
      await owner.query('set local role pertexo_owner');
      await owner.query(
        'alter table app.audit_events no force row level security',
      );
      const proof = await owner.query<{
        audit_count: string;
        batch_count: string;
        future_scan_count: string;
      }>(
        `select
          (select count(*) from app.retention_batches
            where workspace_id=any($1::uuid[]) and not dry_run) batch_count,
          (select count(*) from app.audit_events
            where workspace_id=any($1::uuid[])
              and action='retention.batch_started') audit_count,
          (select count(*) from app.retention_schedule_state
            where workspace_id=any($1::uuid[]) and next_scan_at>clock_timestamp())
            future_scan_count`,
        [scheduledWorkspaceIds],
      );
      expect(proof.rows).toEqual([
        { audit_count: '26', batch_count: '26', future_scan_count: '130' },
      ]);
      await owner.query(
        'alter table app.audit_events force row level security',
      );
      await owner.query('rollback');
    } catch (error: unknown) {
      await owner.query('rollback').catch(() => undefined);
      throw error;
    }

    const apiUrl = new URL(maintenanceUrl);
    apiUrl.username = 'pertexo_api';
    apiUrl.password = 'pertexo-local-api';
    const api = new Pool({ connectionString: apiUrl.toString(), max: 1 });
    try {
      await expect(
        api.query(
          'select * from app.schedule_workflow_run_input_retention(25)',
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        api.query('select * from app.retention_schedule_state'),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await api.end();
    }
  });
});
