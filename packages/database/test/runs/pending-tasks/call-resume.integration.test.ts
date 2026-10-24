import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createFamily } from '../../lifecycle/calls/fixtures.js';
import { admin, pool } from './fixtures.js';
import { withTenantScopedClient } from '../../../src/tenant-access/transactions.js';
import { synchronizeHumanWait } from '../../../src/runs/pending-tasks/lifecycle/time-capacity.queries.js';

it('keeps an ancestor awake while a descendant has an unconsumed Call result', async () => {
  const root = await createFamily({ slotLent: true });
  const leaf = await createFamily({
    workspaceId: root.workspaceId,
    childDays: 0,
  });
  await admin.query(
    'update app.workflow_calls set parent_run_id=$2 where id=$1',
    [leaf.callId, root.childRunId],
  );
  await admin.query(
    'update app.workflow_runs set human_wait_started_at=clock_timestamp(),deadline_at=null where id=$1',
    [root.childRunId],
  );
  for (const runId of [root.parentRunId, root.childRunId]) {
    await admin.query(
      `insert into app.node_runs(id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,status,side_effect_class,control_kind) values($1,$2,$3,'call','call','{}','waiting','safe','workflow_call')`,
      [randomUUID(), root.workspaceId, runId],
    );
  }
  const observe = () =>
    withTenantScopedClient(
      pool,
      { workspaceId: root.workspaceId },
      async (client) => {
        await client.query(
          'select id from app.workflow_runs where id=$1 for no key update',
          [root.parentRunId],
        );
        return synchronizeHumanWait(client, root.workspaceId, {
          runId: root.parentRunId,
          phase: 'loading',
        });
      },
    );
  expect((await observe()).human_wait_started_at).toBeNull();
});
