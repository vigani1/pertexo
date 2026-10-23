import { Client } from 'pg';

import {
  adminUrl,
  randomUUID,
  retention,
  userId,
  withDatabase,
  workspaceId,
} from '../retention.support.js';

export const DAY = 86_400_000;

export const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

export const inline = (value: unknown) =>
  JSON.stringify({ kind: 'inline', value });

export let admin!: Client;

/** Runs the rules until no rule has more rows due. */
export async function enforceUntilIdle() {
  for (let pass = 0; pass < 50; pass += 1)
    if (!(await retention.enforce()).more) return;
  throw new Error('Retention did not become idle');
}

export async function insertRun(
  input: Readonly<{
    completedDaysAgo: number;
    detailsPurged?: boolean;
    replaySourceRunId?: string;
  }>,
): Promise<string> {
  const id = randomUUID();
  const completedAt = daysAgo(input.completedDaysAgo);
  await admin.query(
    `insert into app.workflow_runs
      (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,
       output_ref,error_summary,started_at,completed_at,details_purged_at,
       replay_source_run_id,replay_command_id,created_at,updated_at)
     values($1,$2,$3,$4,$5,'succeeded',$6::jsonb,'failure detail',$7,$7,$8,
       $9,$10,$7,$7)`,
    [
      id,
      workspaceId,
      randomUUID(),
      randomUUID(),
      input.replaySourceRunId === undefined ? 'manual' : 'replay',
      input.detailsPurged === true ? null : inline('output'),
      completedAt,
      input.detailsPurged === true ? completedAt : null,
      input.replaySourceRunId ?? null,
      input.replaySourceRunId === undefined ? null : randomUUID(),
    ],
  );
  return id;
}

export async function insertExecutionDetail(runId: string): Promise<void> {
  const nodeRunId = randomUUID();
  await admin.query(
    `insert into app.node_runs
      (id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
       status,side_effect_class,input_ref,output_ref)
     values($1,$2,$3,'node-1','node-1','{}','succeeded','safe',$4::jsonb,$4::jsonb)`,
    [nodeRunId, workspaceId, runId, inline('node')],
  );
  await admin.query(
    `insert into app.node_attempts
      (id,workspace_id,node_run_id,attempt_number,status,side_effect_class)
     values($1,$2,$3,1,'succeeded','safe')`,
    [randomUUID(), workspaceId, nodeRunId],
  );
  await admin.query(
    `insert into app.run_events(workspace_id,workflow_run_id,sequence,type,payload)
     values($1,$2,1,'run.succeeded','{}')`,
    [workspaceId, runId],
  );
}

export async function count(table: string, runId: string): Promise<number> {
  const result = await admin.query<{ count: string }>(
    `select count(*) from app.${table} where workflow_run_id=$1`,
    [runId],
  );
  return Number(result.rows[0]?.count);
}

export async function runRow(runId: string) {
  const result = await admin.query<{
    details_purged_at: Date | null;
    error_summary: string | null;
    output_ref: unknown;
  }>(
    'select output_ref,error_summary,details_purged_at from app.workflow_runs where id=$1',
    [runId],
  );
  return result.rows[0];
}

/** A schedule trigger, used to give runs a trigger record. */
export async function insertScheduleTrigger(): Promise<string> {
  const workflowId = randomUUID();
  const workflowVersionId = randomUUID();
  const triggerId = randomUUID();
  const fingerprint = `trigger:sha256:${'c'.repeat(64)}`;
  await admin.query(
    `insert into app.workflows(id,workspace_id,name,created_by)
     values($1,$2,'Retention trigger',$3)`,
    [workflowId, workspaceId, userId],
  );
  await admin.query(
    `insert into app.workflow_versions
      (id,workspace_id,workflow_id,version_number,graph_json,
       checksum,executable_json,published_by,published_at)
     values($1,$2,$3,1,'{}',$4,'{}',$5,clock_timestamp())`,
    [
      workflowVersionId,
      workspaceId,
      workflowId,
      `wf:sha256:${'b'.repeat(64)}`,
      userId,
    ],
  );
  await admin.query(
    `insert into app.workflow_triggers
      (id,workspace_id,workflow_id,workflow_version_id,node_id,kind,status,
       desired_config,config_fingerprint,health_status)
     values($1,$2,$3,$4,'schedule-1','schedule','active','{}',$5,'healthy')`,
    [triggerId, workspaceId, workflowId, workflowVersionId, fingerprint],
  );
  await admin.query(
    `insert into app.trigger_schedules
      (trigger_id,workspace_id,recurrence_kind,interval_minutes,misfire_policy,
       config_fingerprint,anchor_at,next_fire_at)
     values($1,$2,'interval',60,'skip',$3,clock_timestamp(),clock_timestamp())`,
    [triggerId, workspaceId, fingerprint],
  );
  return triggerId;
}

export async function insertOccurrence(
  triggerId: string,
  scheduledDaysAgo: number,
  runId?: string,
): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `insert into app.trigger_schedule_occurrences
      (id,workspace_id,trigger_id,scheduled_at,disposition,workflow_run_id,created_at)
     values($1,$2,$3,$4,$5,$6,$4)`,
    [
      id,
      workspaceId,
      triggerId,
      daysAgo(scheduledDaysAgo),
      runId === undefined ? 'skipped' : 'accepted',
      runId ?? null,
    ],
  );
  return id;
}

export async function beforeAllFixture1() {
  // Fixtures are written by the superuser; the rules run as maintenance. Run
  // admission reads the workspace's entitlement in its own scope.
  admin = new Client({ connectionString: withDatabase(adminUrl) });
  await admin.connect();
  await admin.query("select set_config('app.workspace_id', $1, false)", [
    workspaceId,
  ]);
}

export async function afterAllFixture2() {
  await admin.end();
}
