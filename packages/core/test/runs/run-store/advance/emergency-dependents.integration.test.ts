import { randomUUID, createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { callbackWaitConfigSchema } from '@pertexo/workflow-model';
import { createCallbackStore } from '../../../../src/runs/pending-tasks/callbacks/callback.store.js';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import {
  asAdmin,
  apiBaseUrl,
  databaseUrl,
  insertRun,
  workspaceA,
  workflowA,
  versionA,
} from '../run-store.fixture.js';
import { emergencyRun, query } from './emergency.fixture.js';

it('closes persisted tasks and prepared callbacks and durably requests child cancellation despite a lost checkpoint', async () => {
  const f = await emergencyRun();
  const childRunId = await insertRun({
    triggerType: 'workflow_call',
    status: 'running',
  });
  const taskId = randomUUID(),
    callbackId = randomUUID(),
    callId = randomUUID();
  const taskNodeId = randomUUID();
  for (const [id, key, control] of [
    [taskNodeId, 'approval', 'human_task'],
    [randomUUID(), 'call', 'workflow_call'],
    [randomUUID(), 'loop', 'for_each_barrier'],
  ]) {
    await query(
      "insert into app.node_runs(id,workspace_id,workflow_run_id,node_id,invocation_key,status,side_effect_class,control_kind,resume_at) values($1,$2,$3,$4,$4,'waiting','safe',$5::varchar,case when $5::varchar='human_task' then clock_timestamp()+interval '1 day' else null end)",
      [id, workspaceA, f.runId, key, control],
    );
  }
  await query(
    "insert into app.pending_run_tasks(id,workspace_id,run_id,workflow_version_id,node_run_id,invocation_key,kind,config,expires_at) values($1,$2,$3,$4,$5,'approval','approval','{}',clock_timestamp()+interval '1 day')",
    [taskId, workspaceA, f.runId, versionA, taskNodeId],
  );
  const config = callbackWaitConfigSchema.parse({
    mode: 'callback',
    timeoutSeconds: 3600,
  });
  const tokenHash = createHash('sha256').update(callbackId).digest('hex');
  await query(
    "insert into app.pending_run_tasks(id,workspace_id,run_id,workflow_version_id,invocation_key,kind,config,status,callback_node_id,callback_scope,callback_scope_hash,callback_token_hash,callback_key_version) values($1,$2,$3,$4,'callback','callback',$5::jsonb,'prepared','callback','[]',repeat('a',64),$6,'1')",
    [
      callbackId,
      workspaceA,
      f.runId,
      versionA,
      JSON.stringify(config),
      tokenHash,
    ],
  );
  await query(
    "insert into app.workflow_calls(id,workspace_id,parent_run_id,invocation_key,target_workflow_id,target_version_id,target_checksum,input_ref,input_checksum,status,child_run_id,live_child_run_id) values($1,$2,$3,'call',$4,$5,'wf:sha256:'||repeat('a',64),'{\"kind\":\"inline\",\"value\":{}}',repeat('b',64),'accepted',$6,$6)",
    [callId, workspaceA, f.runId, workflowA, versionA, childRunId],
  );
  await asAdmin((client) =>
    client.query(
      'update app.run_checkpoints set scheduler_state=\'{"corrupt":true}\' where workflow_run_id=$1',
      [f.runId],
    ),
  );
  const before = await query<{ active_runs: number }>(
    'select active_runs from app.workspace_execution_admission_counters where workspace_id=$1',
    [workspaceA],
  );
  await expect(f.fail()).resolves.toBe('failed');
  const tasks = await query(
    'select id,status,consumed_at,completed_at from app.pending_run_tasks where run_id=$1 order by id',
    [f.runId],
  );
  expect(tasks.rows).toEqual(
    [taskId, callbackId].sort().map((id) => ({
      id,
      status: 'canceled',
      consumed_at: expect.any(Date) as unknown,
      completed_at: expect.any(Date) as unknown,
    })),
  );
  const calls = await query(
    'select status,consumed_at,cancel_requested_at from app.workflow_calls where id=$1',
    [callId],
  );
  expect(calls.rows).toEqual([
    {
      status: 'accepted',
      consumed_at: expect.any(Date) as unknown,
      cancel_requested_at: expect.any(Date) as unknown,
    },
  ]);
  const wakeup = await query(
    "select id from app.outbox_events where aggregate_id=$1 and job_name='advance-workflow-run'",
    [childRunId],
  );
  expect(wakeup.rows).toHaveLength(1);
  expect(
    (
      await query(
        'select status,completed_at from app.workflow_runs where id=$1',
        [f.runId],
      )
    ).rows,
  ).toEqual([{ status: 'failed', completed_at: expect.any(Date) as unknown }]);
  expect(
    (
      await query(
        'select completed_at from app.inbox_receipts where message_id=$1',
        [f.delivery.outboxEventId],
      )
    ).rows,
  ).toEqual([{ completed_at: expect.any(Date) as unknown }]);
  expect(
    (
      await query(
        'select status from app.run_failure_notification_intents where workflow_run_id=$1',
        [f.runId],
      )
    ).rows,
  ).toEqual([{ status: 'pending' }]);
  expect(
    (
      await query(
        'select id from app.pending_run_tasks where run_id=$1 and consumed_at is null',
        [f.runId],
      )
    ).rows,
  ).toEqual([]);
  const after = await query<{ active_runs: number }>(
    'select active_runs from app.workspace_execution_admission_counters where workspace_id=$1',
    [workspaceA],
  );
  expect(after.rows[0]?.active_runs).toBe(
    (before.rows[0]?.active_runs ?? 0) - 1,
  );
  const callbacks = createCallbackStore(
    parseDatabaseConfig({ connectionString: databaseUrl(apiBaseUrl), max: 1 }),
  );
  try {
    await expect(
      callbacks.respond({
        callback: {
          id: callbackId,
          workspaceId: workspaceA,
          runId: f.runId,
          nodeId: 'callback',
          scopeHash: 'a'.repeat(64),
          keyVersion: '1',
          tokenHash,
          config,
        },
        output: {},
        redactOutput: (value) => value,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ reason: 'closed' });
  } finally {
    await callbacks.close();
  }
});
