import { expect, it } from 'vitest';
import { inputRequestConfigSchema } from '@pertexo/workflow-model';
import { admin, store, taskFixture, userId } from './fixtures.js';
it('allows the starter to submit one captured input response, without changing approval self-decision', async () => {
  const f = await taskFixture();
  await admin.query(
    `update app.pending_run_tasks set kind='input_request',config=$2::jsonb where id=$1`,
    [f.taskId, JSON.stringify(inputRequestConfigSchema.parse({}))],
  );
  const scope = { ...f.scope, actorId: userId };
  expect((await store.read(scope)).canRespond).toBe(true);
  const request = {
    ...scope,
    values: { message: 'Reviewed input' },
    idempotencyKey: 'input-response',
  };
  const first = await store.submit(request);
  const again = await store.submit(request);
  expect(again).toEqual({ ...first, replayed: true });
  expect(first.task).toMatchObject({
    kind: 'input_request',
    status: 'submitted',
    output: { values: { message: 'Reviewed input' }, submittedBy: userId },
  });
  await expect(
    store.submit({
      ...request,
      idempotencyKey: 'second',
      values: { message: 'Other input' },
    }),
  ).rejects.toMatchObject({ reason: 'resolved' });
  const audit = await admin.query(
    `select action,metadata from app.audit_events where workspace_id=$1 and target_id=$2`,
    [f.workspaceId, f.taskId],
  );
  expect(audit.rows).toEqual([
    {
      action: 'pending_task.submitted',
      metadata: { runId: f.parentRunId, status: 'submitted' },
    },
  ]);
});

it('captures one winning response under a race and excludes values from receipts', async () => {
  const f = await taskFixture();
  await admin.query(
    "update app.pending_run_tasks set kind='input_request',config=$2::jsonb where id=$1",
    [f.taskId, JSON.stringify(inputRequestConfigSchema.parse({}))],
  );
  const command = {
    ...f.scope,
    values: { message: 'private-response' },
    idempotencyKey: 'race',
  };
  const results = await Promise.allSettled([
    store.submit(command),
    store.submit({
      ...command,
      actorId: userId,
      values: { message: 'other-private-response' },
    }),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  const receipts = await admin.query(
    'select result_ref from app.idempotency_records where workspace_id=$1',
    [f.workspaceId],
  );
  expect(JSON.stringify(receipts.rows)).not.toContain('private-response');
});

it('accepts one typed multi-select input response and preserves captured prefill', async () => {
  const f = await taskFixture();
  const config = inputRequestConfigSchema.parse({
    fields: [
      {
        id: 'channels',
        name: 'channels',
        label: 'Channels',
        type: 'multi_select',
        options: ['Email', 'SMS'],
      },
    ],
  });
  await admin.query(
    "update app.pending_run_tasks set kind='input_request',config=$2::jsonb,context=$3::jsonb where id=$1",
    [
      f.taskId,
      JSON.stringify(config),
      JSON.stringify({ prefill: { channels: ['Email'] } }),
    ],
  );
  const command = {
    ...f.scope,
    values: { channels: ['SMS'] },
    idempotencyKey: 'multiple',
  };
  const first = await store.submit(command);
  expect(first.task).toMatchObject({
    prefill: { channels: ['Email'] },
    output: { values: { channels: ['SMS'] } },
  });
  expect((await store.submit(command)).replayed).toBe(true);
});
