import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RETENTION_RULES } from '../src/lifecycle/retention-rules.js';
import {
  adminUrl,
  randomUUID,
  retention,
  runIds,
  userId,
  withDatabase,
  workspaceId,
} from './support/retention.integration.support.js';

const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY);
const inline = (value: unknown) =>
  JSON.stringify({ kind: 'inline', schemaVersion: 1, value });

let admin!: Client;

beforeAll(async () => {
  // Fixtures are written by the superuser; the rules run as maintenance. Run
  // admission reads the workspace's entitlement in its own scope.
  admin = new Client({ connectionString: withDatabase(adminUrl) });
  await admin.connect();
  await admin.query("select set_config('app.workspace_id', $1, false)", [
    workspaceId,
  ]);
});

afterAll(async () => {
  await admin.end();
});

/** Runs the rules until no rule has more rows due. */
async function enforceUntilIdle() {
  for (let pass = 0; pass < 50; pass += 1)
    if (!(await retention.enforce()).more) return;
  throw new Error('Retention did not become idle');
}

async function insertRun(
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

async function insertExecutionDetail(runId: string): Promise<void> {
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

async function count(table: string, runId: string): Promise<number> {
  const result = await admin.query<{ count: string }>(
    `select count(*) from app.${table} where workflow_run_id=$1`,
    [runId],
  );
  return Number(result.rows[0]?.count);
}

async function runRow(runId: string) {
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
async function insertScheduleTrigger(): Promise<string> {
  const workflowId = randomUUID();
  const workflowVersionId = randomUUID();
  const triggerId = randomUUID();
  const fingerprint = `trigger:v1:sha256:${'c'.repeat(64)}`;
  await admin.query(
    `insert into app.workflows(id,workspace_id,name,created_by)
     values($1,$2,'Retention trigger',$3)`,
    [workflowId, workspaceId, userId],
  );
  await admin.query(
    `insert into app.workflow_versions
      (id,workspace_id,workflow_id,version_number,schema_version,graph_json,
       checksum,executable_json,published_by,published_at)
     values($1,$2,$3,1,1,'{}',$4,'{}',$5,clock_timestamp())`,
    [
      workflowVersionId,
      workspaceId,
      workflowId,
      `wf:v2:sha256:${'b'.repeat(64)}`,
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

async function insertOccurrence(
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

describe('retention rules', () => {
  it('clears run inputs once they expire', async () => {
    const pending = randomUUID();
    await admin.query(
      `insert into app.workflow_runs
        (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,
         input_ref,input_ref_expires_at)
       values($1,$2,$3,$4,'manual','queued',$5::jsonb,$6)`,
      [
        pending,
        workspaceId,
        randomUUID(),
        randomUUID(),
        inline('kept'),
        new Date(Date.now() + DAY),
      ],
    );

    // Pages of two: the four expired fixture inputs take two passes.
    const first = await retention.enforce();
    expect(first.removed.run_inputs).toBe(2);
    expect(first.more).toBe(true);
    await enforceUntilIdle();

    const inputs = await admin.query<{ id: string; input_ref: unknown }>(
      'select id,input_ref from app.workflow_runs where id = any($1::uuid[])',
      [[...runIds, pending]],
    );
    expect(
      Object.fromEntries(inputs.rows.map((row) => [row.id, row.input_ref])),
    ).toEqual({
      ...Object.fromEntries(runIds.map((id) => [id, null])),
      [pending]: { kind: 'inline', schemaVersion: 1, value: 'kept' },
    });
  });

  it('purges execution details 30 days after completion and keeps the summary', async () => {
    const old = await insertRun({ completedDaysAgo: 40 });
    const recent = await insertRun({ completedDaysAgo: 10 });
    await insertExecutionDetail(old);
    await insertExecutionDetail(recent);

    await enforceUntilIdle();

    expect(await count('node_runs', old)).toBe(0);
    expect(await count('run_events', old)).toBe(0);
    expect(await runRow(old)).toMatchObject({
      output_ref: null,
      error_summary: null,
      details_purged_at: expect.any(Date) as unknown,
    });
    expect(await count('node_runs', recent)).toBe(1);
    expect(await count('run_events', recent)).toBe(1);
    expect(await runRow(recent)).toMatchObject({
      error_summary: 'failure detail',
      details_purged_at: null,
    });
  });

  it('deletes run summaries after 90 days once nothing refers to them', async () => {
    const triggerId = await insertScheduleTrigger();
    const unreferenced = await insertRun({
      completedDaysAgo: 100,
      detailsPurged: true,
    });
    const replaySource = await insertRun({
      completedDaysAgo: 100,
      detailsPurged: true,
    });
    const replayChild = await insertRun({
      completedDaysAgo: 100,
      detailsPurged: true,
      replaySourceRunId: replaySource,
    });
    const scheduled = await insertRun({
      completedDaysAgo: 100,
      detailsPurged: true,
    });
    const recentOccurrence = await insertOccurrence(triggerId, 10, scheduled);
    const tooRecent = await insertRun({
      completedDaysAgo: 80,
      detailsPurged: true,
    });

    await enforceUntilIdle();

    const remaining = await admin.query<{ id: string }>(
      'select id from app.workflow_runs where id = any($1::uuid[])',
      [[unreferenced, replaySource, replayChild, scheduled, tooRecent]],
    );
    // The replay child goes first, then its source on a later page.
    expect(remaining.rows.map(({ id }) => id).sort()).toEqual(
      [scheduled, tooRecent].sort(),
    );
    const occurrences = await admin.query(
      'select 1 from app.trigger_schedule_occurrences where id=$1',
      [recentOccurrence],
    );
    expect(occurrences.rowCount).toBe(1);
  });

  it('deletes schedule occurrences after 90 days and audit records after a year', async () => {
    const triggerId = await insertScheduleTrigger();
    const oldOccurrence = await insertOccurrence(triggerId, 100);
    const recentOccurrence = await insertOccurrence(triggerId, 30);
    const oldAudit = randomUUID();
    const recentAudit = randomUUID();
    for (const [id, days] of [
      [oldAudit, 400],
      [recentAudit, 300],
    ] as const)
      await admin.query(
        `insert into app.audit_events(id,workspace_id,action,target_type,occurred_at)
         values($1,$2,'retention.test','workspace',$3)`,
        [id, workspaceId, daysAgo(days)],
      );

    await enforceUntilIdle();

    const occurrences = await admin.query<{ id: string }>(
      'select id from app.trigger_schedule_occurrences where id = any($1::uuid[])',
      [[oldOccurrence, recentOccurrence]],
    );
    expect(occurrences.rows.map(({ id }) => id)).toEqual([recentOccurrence]);
    const audit = await admin.query<{ id: string }>(
      'select id from app.audit_events where id = any($1::uuid[])',
      [[oldAudit, recentAudit]],
    );
    expect(audit.rows.map(({ id }) => id)).toEqual([recentAudit]);
  });

  it('skips a rule another worker is running', async () => {
    const old = await insertRun({ completedDaysAgo: 40 });
    await insertExecutionDetail(old);
    const index = RETENTION_RULES.findIndex(
      ({ name }) => name === 'run_events',
    );
    const holder = new Client({ connectionString: withDatabase(adminUrl) });
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query('select pg_advisory_xact_lock($1, $2)', [
        1_934_781_128,
        index,
      ]);
      const pass = await retention.enforce();
      expect(pass.removed.run_events).toBe(0);
      expect(pass.removed.node_runs).toBeGreaterThan(0);
      expect(await count('run_events', old)).toBe(1);
    } finally {
      await holder.query('rollback');
      await holder.end();
    }
    await enforceUntilIdle();
    expect(await count('run_events', old)).toBe(0);
  });
});
