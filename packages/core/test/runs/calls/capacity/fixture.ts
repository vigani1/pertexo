import { Pool, type PoolClient } from 'pg';

import { withTenantScopedClient } from '@pertexo/database/primitives';
import { readWorkspaceUsageCapacity } from '../../../../src/runs/queries/usage-capacity.queries.js';

import {
  apiUrl,
  maintenanceUrl,
} from '../../../lifecycle/retention.support.js';
import type { createFamily } from '../../../lifecycle/calls/fixtures.js';
import { admin, insertHint } from '../../../lifecycle/calls/fixtures.js';

type Family = Awaited<ReturnType<typeof createFamily>>;

let maintenance!: Pool;

export let application!: Pool;

export const scoped = <T>(
  workspaceId: string,
  work: (client: PoolClient) => Promise<T>,
) =>
  withTenantScopedClient(maintenance, { workspaceId }, async (client) => {
    await client.query(
      "select set_config('app.workflow_concurrency_protocol','1',true)",
    );
    return work(client);
  });

export async function lend(family: Family, existingOutbox?: string) {
  const outbox =
    existingOutbox ?? (await insertHint(family.workspaceId, family.childRunId));
  return scoped(
    family.workspaceId,
    async (client) =>
      (
        await client.query<{ granted: boolean }>(
          'select app.lend_workflow_run_slot($1,$2,$3,$4) granted',
          [family.workspaceId, family.callId, family.childRunId, outbox],
        )
      ).rows[0]?.granted,
  );
}

export async function takeBack(family: Family) {
  const outbox = await insertHint(family.workspaceId, family.parentRunId);
  return scoped(
    family.workspaceId,
    async (client) =>
      (
        await client.query<{ returned: boolean }>(
          'select app.return_workflow_run_slot($1,$2,$3) returned',
          [family.workspaceId, family.callId, outbox],
        )
      ).rows[0]?.returned,
  );
}

export async function setStatus(
  workspaceId: string,
  runId: string,
  status: string,
) {
  await withTenantScopedClient(application, { workspaceId }, async (client) => {
    await client.query(
      "select set_config('app.workflow_concurrency_protocol','1',true)",
    );
    return client.query(
      `update app.workflow_runs set status=$3::varchar,
      completed_at=case when $3::varchar='succeeded' or $3::varchar='canceled' then clock_timestamp() else null end
      where workspace_id=$1 and id=$2`,
      [workspaceId, runId, status],
    );
  });
}

export const usage = async (workspaceId: string) =>
  (await readWorkspaceUsageCapacity(application, { workspaceId })).execution;

export async function lowerLimit(
  workspaceId: string,
  version: number,
  limit: number,
) {
  await admin.query(
    `insert into app.workspace_execution_entitlement_versions
     (workspace_id,version,active_run_limit,queued_run_limit) values($1,$2,$3,100)`,
    [workspaceId, version, limit],
  );
  await admin.query(
    'update app.workspace_execution_entitlements set current_version=$2 where workspace_id=$1',
    [workspaceId, version],
  );
}

export async function incomingOwner(family: Family) {
  return (
    await admin.query<{ workflow_run_id: string; borrowed_call_id: string }>(
      'select workflow_run_id,borrowed_call_id from app.workflow_run_active_admissions where workspace_id=$1',
      [family.workspaceId],
    )
  ).rows;
}

export function beforeAllFixture1() {
  maintenance = new Pool({ connectionString: maintenanceUrl, max: 2 });
  application = new Pool({ connectionString: apiUrl, max: 1 });
}

export async function afterAllFixture2() {
  await Promise.all([maintenance.end(), application.end()]);
}
