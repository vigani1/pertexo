import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { seedWorkflow, withUpgradeDatabase } from './upgrade-fixture.js';

it('applies earlier vacuum and analyze thresholds to hot tables without changing retained executions', async () => {
  await withUpgradeDatabase(121, async ({ admin, upgrade }) => {
    const { workspaceId, workflowId } = await seedWorkflow(admin);
    const id = randomUUID();
    await admin.query("select set_config('app.workspace_id',$1,false)", [
      workspaceId,
    ]);
    await admin.query(
      `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status) values($1,$2,$3,$4,'manual','succeeded')`,
      [id, workspaceId, workflowId, randomUUID()],
    );
    await upgrade();
    expect(
      (await admin.query(`select id from app.workflow_runs where id=$1`, [id]))
        .rows,
    ).toEqual([{ id }]);
    const settings = await admin.query<{
      relname: string;
      options: Record<string, string>;
    }>(
      `select c.relname,(select jsonb_object_agg(option_name,option_value) from pg_options_to_table(c.reloptions)) options from pg_class c where c.relnamespace='app'::regnamespace and c.relname=any($1::text[]) order by c.relname`,
      [
        [
          'workflow_runs',
          'node_runs',
          'node_attempts',
          'run_checkpoints',
          'run_events',
          'outbox_events',
          'inbox_receipts',
        ],
      ],
    );
    expect(settings.rows).toHaveLength(7);
    for (const table of settings.rows)
      expect(table.options, table.relname).toMatchObject({
        autovacuum_vacuum_scale_factor: '0.02',
        autovacuum_analyze_scale_factor: '0.01',
        autovacuum_vacuum_insert_scale_factor: '0.02',
      });
  });
}, 60_000);
