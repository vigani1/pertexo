import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, afterEach } from 'vitest';
import { createRunValuesStore } from '../../../src/runs/values/repository.js';
import { parseDatabaseConfig } from '../../../src/config.js';
import {
  withTenantScopedClient,
  withWorkspaceReadTransaction,
} from '../../../src/tenant-access/transactions.js';
import { runValuesInTransaction } from '../../../src/runs/values/records.queries.js';
import {
  apiUrl,
  apiPool,
  workspaceId,
  workflowId,
  actorId,
  queryAsOwner,
} from '../../support/workflow-authoring.js';
export * from '../../support/workflow-authoring.js';
export let store: ReturnType<typeof createRunValuesStore>;
const versionId = randomUUID();
beforeAll(async () => {
  store = createRunValuesStore(
    parseDatabaseConfig({ connectionString: apiUrl, max: 6 }),
  );
  await queryAsOwner(
    `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,checksum,executable_json,published_by) values ($1,$2,$3,1,'{"nodes":[],"edges":[],"settings":{}}','wf:sha256:'||repeat('e',64),'{}',$4)`,
    [versionId, workspaceId, workflowId, actorId],
    workspaceId,
  );
});
afterAll(() => store.close());
export function executionQuery<Row extends Record<string, unknown>>(
  text: string,
  parameters: readonly unknown[],
) {
  return withTenantScopedClient(apiPool, { workspaceId }, (client) =>
    client.query<Row>(text, [...parameters]),
  ).then((result) => result.rows);
}
export async function running(trigger = 'api') {
  const runId = randomUUID(),
    nodeRunId = randomUUID(),
    attemptId = randomUUID();
  await executionQuery(
    `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,started_at) values ($1,$2,$3,$4,$5,'running',clock_timestamp())`,
    [runId, workspaceId, workflowId, versionId, trigger],
  );
  await executionQuery(
    `insert into app.node_runs(id,workspace_id,workflow_run_id,node_id,invocation_key,status,side_effect_class) values ($1,$2,$3,'save','save','running','safe')`,
    [nodeRunId, workspaceId, runId],
  );
  await executionQuery(
    `insert into app.node_attempts(id,workspace_id,node_run_id,attempt_number,status,side_effect_class,lease_owner,lease_expires_at,fence_token) values ($1,$2,$3,1,'running','safe','values-worker',clock_timestamp()+interval '5 minutes',1)`,
    [attemptId, workspaceId, nodeRunId],
  );
  await executionQuery(
    `update app.node_runs set current_attempt_id=$2,current_attempt_number=1 where id=$1`,
    [nodeRunId, attemptId],
  );
  return {
    workspaceId,
    runId,
    nodeRunId,
    attemptId,
    attemptNumber: 1,
    workerId: 'values-worker',
    fenceToken: 1,
    nodeId: 'save',
    invocationKey: 'save',
    signal: new AbortController().signal,
  };
}
export function read(runId: string) {
  return withWorkspaceReadTransaction(apiPool, workspaceId, (tx) =>
    runValuesInTransaction(tx, runId),
  );
}
export async function terminal(runId: string, age: string) {
  const adminUrl = new URL(
    process.env.DATABASE_ADMIN_URL ??
      'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres',
  );
  adminUrl.pathname = new URL(apiUrl).pathname;
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  const client = await admin.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    await client.query(
      `update app.workflow_runs set status='succeeded',created_at=clock_timestamp()-$2::interval,started_at=clock_timestamp()-$2::interval+interval '1 second',completed_at=clock_timestamp()-$2::interval+interval '2 seconds' where id=$1`,
      [runId, age],
    );
    await client.query('commit');
  } finally {
    client.release();
    await admin.end();
  }
}

afterEach(async () => {
  await executionQuery(
    "update app.workflow_runs set status='succeeded',completed_at=clock_timestamp() where workspace_id=$1 and status in ('running','waiting')",
    [workspaceId],
  );
});
