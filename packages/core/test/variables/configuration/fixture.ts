import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';

import { createCheckpoint } from '@pertexo/workflow-engine';
import type { WorkspaceVariableSnapshot } from '@pertexo/workflow-model';
import { createWorkspaceVariablesStore } from '../../../src/variables/index.js';

import { parseDatabaseConfig } from '../../../../database/src/config.js';
import { withWorkspaceTransaction } from '../../../../database/src/tenant-access/transactions.js';
import { acceptWorkflowRun } from '../../../../database/src/runs/commands/acceptance.repository.js';

import {
  admin,
  createFamily,
} from '../../../../database/test/lifecycle/calls/fixtures.js';
import {
  apiUrl,
  userId,
} from '../../../../database/test/lifecycle/retention.support.js';

export const config = () =>
  parseDatabaseConfig({ connectionString: apiUrl, max: 4 });

export const admissionApplication = `variable-admission-${randomUUID()}`;

export let store: ReturnType<typeof createWorkspaceVariablesStore>, pool: Pool;

export async function fixture() {
  const family = await createFamily({
    parentDays: 0,
    childDays: 0,
    consumed: true,
  });
  await admin.query(
    `insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'owner','active')`,
    [family.workspaceId, userId],
  );
  const parent = await admin.query<{ workflow_id: string }>(
    'select workflow_id from app.workflow_versions where id=$1',
    [family.parentVersionId],
  );
  const parentWorkflowId = parent.rows[0]?.workflow_id;
  if (parentWorkflowId === undefined)
    throw new Error('Parent workflow missing');
  return { ...family, parentWorkflowId };
}

export async function member(workspaceId: string, role: string) {
  const id = randomUUID();
  await admin.query(
    "insert into app.users(id,email,display_name) values($1,$2,'Variable member')",
    [id, `${id}@example.test`],
  );
  await admin.query(
    "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,$3,'active')",
    [workspaceId, id, role],
  );
  return id;
}

export const scope = (workspaceId: string) => ({
  workspaceId,
  actorId: userId,
});

export const hash = () =>
  createHash('sha256').update(randomUUID()).digest('hex');

export async function admit(
  f: Awaited<ReturnType<typeof fixture>>,
  key = hash(),
) {
  return withWorkspaceTransaction(pool, f.workspaceId, (transaction) =>
    acceptWorkflowRun(transaction, {
      initialCheckpoint: createCheckpoint({
        workflowVersionId: f.parentVersionId,
        iterationBudget: 200,
        nextEventSequence: 2,
      }),
      keyHash: key,
      requestHash: 'f'.repeat(64),
      scope: `workflow:${f.parentWorkflowId}`,
      operation: 'workflow.run.accept',
      triggerType: 'manual',
      startedBy: userId,
      workflowId: f.parentWorkflowId,
      workflowVersionId: f.parentVersionId,
    }),
  );
}

export async function snapshot(runId: string) {
  return (
    await admin.query<{ snapshot: WorkspaceVariableSnapshot | null }>(
      `select case when run.details_purged_at is not null then null else jsonb_build_object(
       'revision',coalesce(run.variable_set_revision,0),'values',case when run.variable_set_revision is null then '{}'::jsonb else variable_set.values_json end) end snapshot
       from app.workflow_runs run left join app.workspace_variable_set_revisions variable_set
         on variable_set.workspace_id=run.workspace_id and variable_set.revision=run.variable_set_revision where run.id=$1`,
      [runId],
    )
  ).rows[0]?.snapshot;
}

export function beforeAllFixture1() {
  store = createWorkspaceVariablesStore(config());
  pool = new Pool({
    connectionString: apiUrl,
    max: 4,
    application_name: admissionApplication,
  });
}

export async function afterAllFixture2() {
  await store.close();
  await pool.end();
}
