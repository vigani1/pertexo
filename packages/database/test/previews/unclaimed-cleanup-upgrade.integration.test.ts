import { randomUUID } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { expect, it } from 'vitest';
import {
  seedWorkflow,
  withDatabase,
} from '../platform/migrations/upgrade-fixture.js';

it('upgrades populated preview rows and grants maintenance only the terminal-cleanup writes', async () => {
  await withDatabase(async ({ admin }) => {
    const { workspaceId, workflowId, ownerId } = await seedWorkflow(admin);
    const previewRunId = randomUUID(),
      attemptId = randomUUID();
    await admin.query(
      `insert into app.preview_runs(id,workspace_id,workflow_id,draft_revision,draft_fingerprint,node_id,
       definition_key,definition_version,executor_key,executor_version,actor_user_id,idempotency_key_hash,request_hash,
       executable_node_json,input_ref,side_effect_class,may_contact_provider,may_cause_external_side_effect,dry_run,
       execution_deadline_at,expires_at) values($1,$2,$3,1,$4,'step','core.set',1,'core.set',1,$5,$6,$7,
       '{"id":"step","type":"core.set"}','{"kind":"inline","value":null}','safe',false,false,'not_supported',
       clock_timestamp()+interval '1 hour',clock_timestamp()+interval '1 day')`,
      [
        previewRunId,
        workspaceId,
        workflowId,
        'a'.repeat(64),
        ownerId,
        'b'.repeat(64),
        'c'.repeat(64),
      ],
    );
    await admin.query(
      "insert into app.preview_attempts(id,workspace_id,preview_run_id,status,side_effect_class) values($1,$2,$3,'queued','safe')",
      [attemptId, workspaceId, previewRunId],
    );
    const read = async () =>
      (
        await admin.query<{ snapshot: string }>(
          'select row_to_json(r)::text snapshot from app.preview_runs r where id=$1',
          [previewRunId],
        )
      ).rows;
    const before = await read();

    expect(await read()).toEqual(before);
    const maintenance = await admin.connect();
    try {
      await maintenance.query('begin');
      await maintenance.query('set local role pertexo_maintenance');
      await maintenance.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      expect(
        (
          await maintenance.query(
            "update app.preview_attempts set status='timed_out',started_at=clock_timestamp(),completed_at=clock_timestamp(),safe_error_code='preview.deadline_exceeded' where id=$1 returning status",
            [attemptId],
          )
        ).rows,
      ).toEqual([{ status: 'timed_out' }]);
      expect(
        (
          await maintenance.query(
            "update app.preview_runs set status='timed_out',started_at=clock_timestamp(),completed_at=clock_timestamp(),safe_error_code='preview.deadline_exceeded' where id=$1 returning status",
            [previewRunId],
          )
        ).rows,
      ).toEqual([{ status: 'timed_out' }]);
      await maintenance.query(
        "insert into app.usage_events(id,workspace_id,category,quantity,resource_type,resource_id,idempotency_key,metadata) values($1,$2,'preview_execution',1,'preview-run',$3,$4,'{}')",
        [
          uuidv7(),
          workspaceId,
          previewRunId,
          `preview-terminal:${previewRunId}`,
        ],
      );
      await expect(
        maintenance.query(
          'update app.preview_attempts set dispatch_marked_at=clock_timestamp() where id=$1',
          [attemptId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await maintenance.query('rollback');
      maintenance.release();
    }
  });
});
