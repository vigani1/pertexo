import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { seedWorkflow, withDatabase } from './upgrade-fixture.js';

it('preserves large execution values on upgrade and unrelated updates while enforcing byte limits on writes', async () => {
  await withDatabase(async ({ admin }) => {
    const { workspaceId, workflowId } = await seedWorkflow(admin);
    const client = await admin.connect();
    try {
      const id = randomUUID();
      const value = JSON.stringify({
        kind: 'inline',
        value: 'x'.repeat(1_800_000),
      });
      await client.query("select set_config('app.workspace_id',$1,false)", [
        workspaceId,
      ]);
      await client.query(
        `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,input_ref,input_ref_expires_at) values($1,$2,$3,$4,'manual','succeeded',$5,clock_timestamp()+interval '1 day')`,
        [id, workspaceId, workflowId, randomUUID(), value],
      );

      await client.query(
        `update app.workflow_runs set updated_at=clock_timestamp() where id=$1`,
        [id],
      );
      expect(
        (
          await client.query(
            `select input_ref::text value from app.workflow_runs where id=$1`,
            [id],
          )
        ).rows,
      ).toEqual([{ value }]);
      const oversized = JSON.stringify({
        kind: 'inline',
        value: 'x'.repeat(4_194_304),
      });
      await expect(
        client.query(`update app.workflow_runs set input_ref=$2 where id=$1`, [
          id,
          oversized,
        ]),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'workflow_runs_input_ref_bounded',
      });
      await expect(
        client.query(`update app.workflow_runs set output_ref=$2 where id=$1`, [
          id,
          oversized,
        ]),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'workflow_runs_output_ref_bounded',
      });
      await expect(
        client.query(
          `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,input_ref,input_ref_expires_at) values($1,$2,$3,$4,'manual','succeeded',$5,clock_timestamp()+interval '1 day')`,
          [randomUUID(), workspaceId, workflowId, randomUUID(), oversized],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'workflow_runs_input_ref_bounded',
      });
      expect(
        (
          await client.query(
            `select input_ref::text value,output_ref from app.workflow_runs where id=$1`,
            [id],
          )
        ).rows,
      ).toEqual([{ value, output_ref: null }]);
    } finally {
      client.release();
    }
  });
}, 60_000);
