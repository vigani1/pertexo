import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { seedWorkflow, withUpgradeDatabase } from './upgrade-fixture.js';

it('enforces every execution document limit for each role permitted to write it', async () => {
  await withUpgradeDatabase(122, async ({ admin }) => {
    const { workspaceId, workflowId, ownerId } = await seedWorkflow(admin);
    const run = randomUUID(),
      version = randomUUID(),
      node = randomUUID(),
      preview = randomUUID();
    await admin.query("select set_config('app.workspace_id',$1,false)", [
      workspaceId,
    ]);
    await admin.query(
      `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status) values($1,$2,$3,$4,'manual','succeeded')`,
      [run, workspaceId, workflowId, version],
    );
    await admin.query(
      `insert into app.node_runs(id,workspace_id,workflow_run_id,node_id,invocation_key,status,side_effect_class) values($1,$2,$3,'step','step','ready','safe')`,
      [node, workspaceId, run],
    );
    await admin.query(
      `insert into app.node_attempts(id,workspace_id,node_run_id,attempt_number,status,side_effect_class) values($1,$2,$3,1,'ready','safe')`,
      [randomUUID(), workspaceId, node],
    );
    await admin.query(
      `insert into app.preview_runs(id,workspace_id,workflow_id,draft_revision,draft_fingerprint,node_id,definition_key,definition_version,executor_key,executor_version,actor_user_id,idempotency_key_hash,request_hash,executable_node_json,input_ref,side_effect_class,may_contact_provider,may_cause_external_side_effect,dry_run,execution_deadline_at,expires_at) values($1,$2,$3,1,$4,'step','core.set',1,'core.set',1,$5,$4,$4,'{}','{"kind":"inline","value":null}','safe',false,false,'not_supported',clock_timestamp()+interval '1 hour',clock_timestamp()+interval '1 day')`,
      [preview, workspaceId, workflowId, 'a'.repeat(64), ownerId],
    );
    await admin.query(
      `insert into app.preview_attempts(id,workspace_id,preview_run_id,status,side_effect_class) values($1,$2,$3,'queued','safe')`,
      [randomUUID(), workspaceId, preview],
    );
    await admin.query(
      `insert into app.pending_run_tasks(id,workspace_id,run_id,workflow_version_id,node_run_id,invocation_key,kind,config,expires_at) values($1,$2,$3,$4,$5,'step','approval','{}',clock_timestamp()+interval '1 day')`,
      [randomUUID(), workspaceId, run, version, node],
    );
    const cases = [
      ['node_runs', 'input_ref', 'node_runs_input_ref_bounded', 4194304],
      ['node_runs', 'output_ref', 'node_runs_output_ref_bounded', 4194304],
      [
        'node_attempts',
        'output_ref',
        'node_attempts_output_ref_bounded',
        4194304,
      ],
      ['preview_runs', 'input_ref', 'preview_runs_input_bounded', 4194304],
      ['preview_runs', 'output_ref', 'preview_runs_output_bounded', 4194304],
      [
        'preview_runs',
        'executable_node_json',
        'preview_runs_node_bounded',
        2097152,
      ],
      [
        'preview_attempts',
        'output_ref',
        'preview_attempts_output_bounded',
        4194304,
      ],
      [
        'pending_run_tasks',
        'output_ref',
        'pending_run_tasks_output_bounded',
        4194304,
      ],
    ] as const;
    const client = await admin.connect();
    try {
      await client.query("select set_config('app.workspace_id',$1,false)", [
        workspaceId,
      ]);
      for (const role of [
        'pertexo_app',
        'pertexo_maintenance',
        'pertexo_owner',
      ]) {
        await client.query(`set role ${role}`);
        for (const [table, column, constraint, limit] of cases) {
          const rights = await admin.query<{
            insert: boolean;
            update: boolean;
          }>(
            `select has_table_privilege($1,$2,'INSERT') as insert,has_column_privilege($1,$2,$3,'UPDATE') as update`,
            [role, `app.${table}`, column],
          );
          const value = JSON.stringify({
            kind: 'inline',
            value: 'x'.repeat(limit),
          });
          if (rights.rows[0]?.insert)
            await expect(
              client.query(
                `insert into app.${table} select (jsonb_populate_record(null::app.${table},to_jsonb(r)||jsonb_build_object($1::text,$2::jsonb))).* from app.${table} r`,
                [column, value],
              ),
              `${role} insert ${table}.${column}`,
            ).rejects.toMatchObject({ code: '23514', constraint });
          if (rights.rows[0]?.update)
            await expect(
              client.query(`update app.${table} set ${column}=$1`, [value]),
              `${role} update ${table}.${column}`,
            ).rejects.toMatchObject({ code: '23514', constraint });
        }
      }
    } finally {
      await client.query('reset role');
      client.release();
    }
  });
}, 60_000);
