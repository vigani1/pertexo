import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll } from 'vitest';

import { createScheduleTriggerTestEnvironment } from '../support/schedule-triggers.js';

/** A migrated database with a workspace, a published workflow and a run to replay. */
export const schedule = createScheduleTriggerTestEnvironment({
  includeOperator: true,
});
export const { ownerQuery, versionId, workerQuery, workflowId, workspaceId } =
  schedule;
export let sourceRunId = '';
/** Only the operator's role writes command rows, so a seeded receipt goes in as it. */
export let maintenance: Pool;

beforeAll(async () => {
  sourceRunId = await schedule.initialize();
  const url = new URL(
    process.env.DATABASE_MAINTENANCE_URL ??
      'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo',
  );
  url.pathname = new URL(schedule.apiConnectionString).pathname;
  maintenance = new Pool({ connectionString: url.toString(), max: 1 });
});
afterAll(async () => {
  await maintenance.end();
  await schedule.close();
});

export const actorRef = 'operator:pin';
export const reason = 'pin what the operator pass must not change';
export const base = () => ({
  actorRef,
  commandId: randomUUID(),
  reason,
  workspaceId,
});

export type AuditRow = Readonly<{
  action: string;
  target_type: string;
  target_id: string;
  request_id: string;
  metadata: Record<string, unknown>;
}>;

export async function auditFor(commandId: string) {
  const { rows } = await ownerQuery<AuditRow>(
    `select action,target_type,target_id,request_id,metadata
     from app.audit_events where workspace_id=$1 and request_id=$2
     order by occurred_at,id`,
    [workspaceId, commandId],
  );
  return rows;
}

export async function storedCommand(commandId: string) {
  const { rows } = await workerQuery<{ outcome: string; status: string }>(
    'select outcome,status from app.operator_commands where id=$1',
    [commandId],
  );
  return rows[0];
}
