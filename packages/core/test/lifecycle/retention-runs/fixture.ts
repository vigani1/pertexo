import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, beforeAll, expect } from 'vitest';

import {
  adminUrl,
  retention,
  withDatabase,
  workspaceId,
} from '../retention.support.js';

export const DAY = 86_400_000;
export const MINUTE = 60_000;
export const ago = (millis: number) => new Date(Date.now() - millis);

export let admin!: Client;

beforeAll(async () => {
  admin = new Client({ connectionString: withDatabase(adminUrl) });
  await admin.connect();
  await admin.query("select set_config('app.workspace_id', $1, false)", [
    workspaceId,
  ]);
});

afterAll(async () => {
  await admin.end();
});

type RunShape = Readonly<{
  completedAt?: Date;
  createdAt?: Date;
  purged?: boolean;
  status?: string;
  triggerType?: string;
}>;

export async function insertRun({
  completedAt,
  createdAt,
  purged = false,
  status = completedAt === undefined ? 'running' : 'succeeded',
  triggerType = 'manual',
}: RunShape): Promise<string> {
  const id = randomUUID();
  const created = createdAt ?? completedAt ?? new Date();
  await admin.query(
    `insert into app.workflow_runs
      (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,
       output_ref,error_summary,started_at,completed_at,details_purged_at,
       created_at,updated_at)
     values($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$9,$9)`,
    [
      id,
      workspaceId,
      randomUUID(),
      randomUUID(),
      triggerType,
      status,
      purged ? null : JSON.stringify({ kind: 'inline', value: 'output' }),
      purged ? null : 'failure detail',
      created,
      completedAt ?? null,
      purged ? (completedAt ?? new Date()) : null,
    ],
  );
  return id;
}

export async function insertNodeRun(runId: string): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `insert into app.node_runs
      (id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
       status,side_effect_class)
     values($1,$2,$3,'node',$4,'{}','succeeded','safe')`,
    [id, workspaceId, runId, `node-${id}`],
  );
  await admin.query(
    `insert into app.node_attempts
      (id,workspace_id,node_run_id,attempt_number,status,side_effect_class)
     values($1,$2,$3,1,'succeeded','safe')`,
    [randomUUID(), workspaceId, id],
  );
  return id;
}

export async function insertEvent(runId: string, sequence = 1): Promise<void> {
  await admin.query(
    `insert into app.run_events(workspace_id,workflow_run_id,sequence,type,payload)
     values($1,$2,$3,'run.succeeded','{}')`,
    [workspaceId, runId, sequence],
  );
}

export async function insertCheckpoint(runId: string): Promise<void> {
  await admin.query(
    `insert into app.run_checkpoints
      (workflow_run_id,workspace_id,workflow_version_id,revision,scheduler_state)
     select id,workspace_id,workflow_version_id,1,'{}'
       from app.workflow_runs where id=$1`,
    [runId],
  );
}

export async function insertDetails(runId: string): Promise<void> {
  await insertNodeRun(runId);
  await insertEvent(runId);
  await insertCheckpoint(runId);
}

export async function countOf(table: string, runId: string): Promise<number> {
  const result = await admin.query<{ count: number }>(
    `select count(*)::int "count" from app.${table} where workflow_run_id=$1`,
    [runId],
  );
  return result.rows[0]?.count ?? -1;
}

export async function detailCounts(runId: string) {
  return {
    node_runs: await countOf('node_runs', runId),
    run_events: await countOf('run_events', runId),
    run_checkpoints: await countOf('run_checkpoints', runId),
  };
}

export const allDetails = { node_runs: 1, run_events: 1, run_checkpoints: 1 };
export const noDetails = { node_runs: 0, run_events: 0, run_checkpoints: 0 };

export async function summary(runId: string) {
  const result = await admin.query<{
    details_purged_at: Date | null;
    error_summary: string | null;
    output_ref: unknown;
  }>(
    'select details_purged_at,error_summary,output_ref from app.workflow_runs where id=$1',
    [runId],
  );
  return result.rows[0];
}

export async function untilIdle(): Promise<void> {
  for (let pass = 0; pass < 200; pass += 1)
    if (!(await retention.enforce()).more) return;
  throw new Error('Retention did not become idle');
}

export const PURGED = expect.any(Date) as Date;
