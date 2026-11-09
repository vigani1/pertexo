import { expect, it } from 'vitest';
import { withDatabase } from './upgrade-fixture.js';

it('configures hot tables on an empty database without an upgrade prerequisite', async () => {
  await withDatabase(async ({ admin }) => {
    const tables = [
      'workflow_runs',
      'node_runs',
      'node_attempts',
      'run_checkpoints',
      'run_events',
      'outbox_events',
      'inbox_receipts',
    ];
    const result = await admin.query<{
      relname: string;
      options: Record<string, string>;
    }>(
      `select c.relname,(select jsonb_object_agg(option_name,option_value) from pg_options_to_table(c.reloptions)) options from pg_class c where c.relnamespace='app'::regnamespace and c.relname=any($1::text[])`,
      [tables],
    );
    expect(result.rows.map((row) => row.relname).sort()).toEqual(tables.sort());
    for (const row of result.rows)
      expect(row.options, row.relname).toMatchObject({
        autovacuum_vacuum_scale_factor: '0.02',
        autovacuum_analyze_scale_factor: '0.01',
        autovacuum_vacuum_insert_scale_factor: '0.02',
      });
  });
}, 60_000);

it('seeds the instance limits and fair-dispatch cursor on the baseline', async () => {
  await withDatabase(async ({ admin }) => {
    expect(
      (
        await admin.query(
          'select singleton,active_run_limit,queued_run_limit,artifact_count_limit,pending_task_limit from app.instance_capacity',
        )
      ).rows,
    ).toEqual([
      {
        singleton: true,
        active_run_limit: 20,
        queued_run_limit: 10000,
        artifact_count_limit: 10000,
        pending_task_limit: 10000,
      },
    ]);
    expect(
      (
        await admin.query(
          'select singleton,last_workspace_id from app.outbox_fair_dispatch_cursor',
        )
      ).rows,
    ).toEqual([{ singleton: true, last_workspace_id: null }]);
  });
});
