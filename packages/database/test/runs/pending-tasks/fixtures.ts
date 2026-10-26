import { Pool } from 'pg';
import { beforeAll, afterAll } from 'vitest';
import { approvalConfigSchema } from '@pertexo/workflow-model';
import { createPendingTaskStore } from '../../../src/runs/pending-tasks/responses/repository.js';
import { parseDatabaseConfig } from '../../../src/config.js';
import { withTenantScopedClient } from '../../../src/tenant-access/transactions.js';
import { synchronizeHumanWait } from '../../../src/runs/pending-tasks/lifecycle/time-capacity.queries.js';
import { admin, createFamily } from '../../lifecycle/calls/fixtures.js';
import { apiUrl, userId } from '../../lifecycle/retention.support.js';
export { admin, userId };
export let store: ReturnType<typeof createPendingTaskStore>;
export let pool: Pool;
beforeAll(() => {
  pool = new Pool({ connectionString: apiUrl, max: 4 });
  store = createPendingTaskStore(
    parseDatabaseConfig({ connectionString: apiUrl, max: 4 }),
  );
});
afterAll(async () => {
  await Promise.all([store.close(), pool.end()]);
});
export async function taskFixture(
  input: Readonly<{
    named?: boolean;
    allowStarterToDecide?: boolean;
    onExpiry?: 'fail' | 'continue';
    budget?: boolean;
    hardDeadline?: boolean;
    unlimited?: boolean;
  }> = {},
) {
  const family = await createFamily({ childDays: 0, consumed: true });
  const deciderId = crypto.randomUUID();
  await admin.query(
    `insert into app.users(id,email,display_name) values($1,$2,'Approver')`,
    [deciderId, `${deciderId}@example.test`],
  );
  for (const [id, role] of [
    [userId, 'owner'],
    [deciderId, input.named ? 'viewer' : 'admin'],
  ])
    await admin.query(
      `insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,$3,'active')`,
      [family.workspaceId, id, role],
    );
  const taskId = crypto.randomUUID();
  const nodeRunId = crypto.randomUUID();
  const invocationKey = `${family.parentVersionId}|approval|b:|i:`;
  const config = approvalConfigSchema.parse({
    ...(input.named ? { audience: { roles: [], memberIds: [deciderId] } } : {}),
    ...(input.allowStarterToDecide === undefined
      ? {}
      : { allowStarterToDecide: input.allowStarterToDecide }),
    ...(input.onExpiry === undefined ? {} : { onExpiry: input.onExpiry }),
  });
  await admin.query(
    `update app.workflow_runs set started_by=$2,deadline_at=case when $3 then null else clock_timestamp()+interval '30 minutes' end,absolute_deadline_at=case when $4 then clock_timestamp()+interval '5 days' else null end where id=$1`,
    [
      family.parentRunId,
      userId,
      input.unlimited === true,
      input.hardDeadline === true,
    ],
  );
  await admin.query(
    `insert into app.node_runs(id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,status,side_effect_class,control_kind,resume_at) values($1,$2,$3,'approval',$4,'{"branchPath":[],"iterationPath":[]}','waiting','safe','human_task',clock_timestamp()+interval '7 days')`,
    [nodeRunId, family.workspaceId, family.parentRunId, invocationKey],
  );
  await admin.query(
    `insert into app.pending_run_tasks(id,workspace_id,run_id,workflow_version_id,node_run_id,invocation_key,kind,config,expires_at) values($1,$2,$3,$4,$5,$6,'approval',$7::jsonb,clock_timestamp()+interval '7 days')`,
    [
      taskId,
      family.workspaceId,
      family.parentRunId,
      family.parentVersionId,
      nodeRunId,
      invocationKey,
      JSON.stringify(config),
    ],
  );
  return {
    ...family,
    taskId,
    nodeRunId,
    deciderId,
    scope: { workspaceId: family.workspaceId, actorId: deciderId, taskId },
  };
}
export async function sync(f: Awaited<ReturnType<typeof taskFixture>>) {
  return withTenantScopedClient(
    pool,
    { workspaceId: f.workspaceId },
    async (client) => {
      await client.query(
        'select id from app.workflow_runs where id=$1 for no key update',
        [f.parentRunId],
      );
      return synchronizeHumanWait(client, f.workspaceId, {
        runId: f.parentRunId,
        phase: 'loading',
      });
    },
  );
}
