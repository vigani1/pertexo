import { expect, it } from 'vitest';
import { inputRequestConfigSchema } from '@pertexo/workflow-model';
import { rolesForCapability } from '@pertexo/policy';
import { withTenantScopedClient } from '@pertexo/database/primitives';
import { lockWorkspaceAuthority } from '../../../src/shared/authority.repository.js';
import { readFolderScope } from '../../../src/shared/facts.repository.js';
import { readTaskUploadTarget } from '../../../src/runs/pending-tasks/responses/pending-task-records.repository.js';
import { loadUploadTarget } from '../../../src/artifacts/form-uploads/targets.repository.js';
import { admin, pool, taskFixture, userId } from './pending-tasks.fixture.js';

it('reads bounded upload eligibility without retained task details and keeps its captured audience', async () => {
  const f = await taskFixture({ named: true });
  const workflowId = (
    await admin.query<{ workflow_id: string }>(
      'select workflow_id from app.workflow_runs where id=$1',
      [f.parentRunId],
    )
  ).rows[0]?.workflow_id;
  expect(workflowId).toBeTypeOf('string');
  const config = inputRequestConfigSchema.parse({
    audience: { roles: [], memberIds: [f.deciderId] },
    fields: [
      {
        id: 'proof',
        name: 'proof',
        label: 'Proof',
        type: 'file',
        accept: ['documents'],
      },
    ],
  });
  await admin.query(
    "update app.pending_run_tasks set kind='input_request',config=$2::jsonb,context=$3::jsonb where id=$1",
    [
      f.taskId,
      JSON.stringify(config),
      JSON.stringify({ details: { retained: 'x'.repeat(64_000) } }),
    ],
  );
  const target = await withTenantScopedClient(pool, f.scope, async (client) => {
    const role = await lockWorkspaceAuthority(
      client,
      f.workspaceId,
      f.deciderId,
      rolesForCapability('run:read'),
    );
    return readTaskUploadTarget(client, f.scope, {
      role,
      resources: await readFolderScope(client, f.scope, role),
    });
  });
  expect(target).toMatchObject({
    id: f.taskId,
    workflow_id: workflowId,
    kind: 'input_request',
    config,
    blocked_reason: null,
  });
  expect(Buffer.byteLength(JSON.stringify(target))).toBeLessThan(8_192);
  const uploaded = await withTenantScopedClient(pool, f.scope, (client) =>
    loadUploadTarget(
      client,
      { kind: 'input_request', ...f.scope },
      { write: true },
    ),
  );
  expect(uploaded).toMatchObject({
    workflowId: workflowId,
    taskId: f.taskId,
    fields: config.fields,
    uploadedBy: f.deciderId,
  });
  await expect(
    withTenantScopedClient(pool, { ...f.scope, actorId: userId }, (client) =>
      loadUploadTarget(
        client,
        { kind: 'input_request', ...f.scope, actorId: userId },
        { write: true },
      ),
    ),
  ).rejects.toMatchObject({ reason: 'audience' });
});
