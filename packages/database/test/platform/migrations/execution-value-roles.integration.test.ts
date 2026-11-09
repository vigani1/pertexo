import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { seedWorkflow, withDatabase } from './upgrade-fixture.js';

for (const role of ['pertexo_app', 'pertexo_maintenance', 'pertexo_owner'])
  for (const column of ['input_ref', 'output_ref'])
    it(`refuses oversized workflow ${column} inserts and updates as ${role}`, async () => {
      await withDatabase(async ({ admin }) => {
        const { workspaceId, workflowId } = await seedWorkflow(admin);
        const client = await admin.connect();
        const id = randomUUID();
        const oversized = JSON.stringify({
          kind: 'inline',
          value: 'é'.repeat(2_097_152),
        });
        const insert = `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,${column},input_ref_expires_at) values($1,$2,$3,$4,'manual','succeeded',$5,${column === 'input_ref' ? "clock_timestamp()+interval '1 day'" : 'null'})`;
        try {
          await client.query(`set role ${role}`);
          await client.query("select set_config('app.workspace_id',$1,false)", [
            workspaceId,
          ]);
          const error = {
            code: '23514',
            constraint: `workflow_runs_${column}_bounded`,
          };
          await expect(
            client.query(insert, [
              id,
              workspaceId,
              workflowId,
              randomUUID(),
              oversized,
            ]),
          ).rejects.toMatchObject(error);
          await client.query(insert, [
            id,
            workspaceId,
            workflowId,
            randomUUID(),
            '{"kind":"inline","value":"retained"}',
          ]);
          if (role !== 'pertexo_app' || column !== 'input_ref')
            await expect(
              client.query(
                `update app.workflow_runs set ${column}=$2 where id=$1`,
                [id, oversized],
              ),
            ).rejects.toMatchObject(error);
          expect(
            (
              await client.query(
                `update app.workflow_runs set output_ref=output_ref where id=$1 returning ${column} value`,
                [id],
              )
            ).rows,
          ).toEqual([{ value: { kind: 'inline', value: 'retained' } }]);
        } finally {
          await client.query('reset role');
          client.release();
        }
      });
    }, 60_000);
