import { afterAll, afterEach, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';
import { callbackWaitConfigSchema } from '@pertexo/workflow-model';
import { createCallbackStore } from '../../../../src/runs/pending-tasks/callbacks/repository.js';
import { parseDatabaseConfig } from '../../../../src/config.js';
import {
  running,
  executionQuery,
  apiUrl,
  workspaceId,
  otherWorkspaceId,
  queryAsOwner,
  enforceTestRetention,
  apiPool,
} from '../../values/fixtures.js';
export {
  running,
  executionQuery,
  workspaceId,
  otherWorkspaceId,
  queryAsOwner,
  enforceTestRetention,
  apiPool,
};
export let callbacks: ReturnType<typeof createCallbackStore>;
beforeAll(() => {
  callbacks = createCallbackStore(
    parseDatabaseConfig({ connectionString: apiUrl, max: 6 }),
  );
});
afterAll(() => callbacks.close());
afterEach(async () => {
  await queryAsOwner(
    "delete from app.pending_run_tasks where workspace_id=$1 and kind='callback'",
    [workspaceId],
    workspaceId,
  );
  await queryAsOwner(
    'update app.workspace_execution_entitlement_versions set queued_run_limit=100 where workspace_id=$1 and version=1',
    [workspaceId],
    workspaceId,
  );
});
export const config = callbackWaitConfigSchema.parse({
  mode: 'callback',
  timeoutSeconds: 3600,
});
export const hash = (id: string) =>
  createHash('sha256').update(id).digest('hex');
export async function prepared(
  trigger = 'api',
  target = 'wait',
  iteration: readonly unknown[] = [],
) {
  const scope = await running(trigger);
  await queryAsOwner(
    'update app.node_runs set branch_context=$2::jsonb where id=$1',
    [
      scope.nodeRunId,
      JSON.stringify({ branchPath: [], iterationPath: iteration }),
    ],
    workspaceId,
  );
  const records = await callbacks.prepare({
    ...scope,
    targets: [{ nodeId: target, config }],
    keyVersion: '1',
    tokenHash: ({ id }) => hash(id),
  });
  const callback = records[0];
  if (callback === undefined) throw new Error('Callback missing');
  return { scope, callback };
}
export const response = {
  body: { accepted: 17 },
  headers: { 'content-type': 'application/json' },
};
export const unchanged = (value: string) => value;
