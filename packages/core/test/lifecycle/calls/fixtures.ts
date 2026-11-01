import { Client } from 'pg';
import { afterAll, beforeAll } from 'vitest';
import { canonicalOutboxPayloadChecksum } from '@pertexo/database/primitives';
import {
  adminUrl,
  randomUUID,
  userId,
  withDatabase,
} from '../retention.support.js';

export const daysAgo = (days: number): Date =>
  new Date(Date.now() - days * 86_400_000);
export const inline = (value: unknown): string =>
  JSON.stringify({ kind: 'inline', value });
export const checksum = `wf:sha256:${'a'.repeat(64)}`;
export let admin!: Client;

beforeAll(async () => {
  admin = new Client({ connectionString: withDatabase(adminUrl) });
  await admin.connect();
});
afterAll(async () => {
  await admin.end();
});

export async function createFamily(
  input: Readonly<{
    childDays?: number;
    parentDays?: number;
    consumed?: boolean;
    slotLent?: boolean;
    childQueued?: boolean;
    workspaceId?: string;
    executableJson?: unknown;
  }> = {},
) {
  const workspaceId = input.workspaceId ?? randomUUID();
  const parentWorkflowId = randomUUID();
  const childWorkflowId = randomUUID();
  const parentVersionId = randomUUID();
  const childVersionId = randomUUID();
  const parentRunId = randomUUID();
  const childRunId = randomUUID();
  const callId = randomUUID();
  await admin.query("select set_config('app.workspace_id', $1, false)", [
    workspaceId,
  ]);
  if (input.workspaceId === undefined)
    await admin.query(
      `insert into app.workspaces(id,name,slug,created_by)
     values($1,'Call retention',$2,$3)`,
      [workspaceId, `calls-${workspaceId}`, userId],
    );
  for (const [workflowId, versionId] of [
    [parentWorkflowId, parentVersionId],
    [childWorkflowId, childVersionId],
  ]) {
    await admin.query(
      `insert into app.workflows(id,workspace_id,name,created_by)
       values($1,$2,'Call retention',$3)`,
      [workflowId, workspaceId, userId],
    );
    await admin.query(
      `insert into app.workflow_versions
       (id,workspace_id,workflow_id,version_number,graph_json,executable_json,checksum,published_by)
       values($1,$2,$3,1,'{}',$6::jsonb,$4,$5)`,
      [
        versionId,
        workspaceId,
        workflowId,
        checksum,
        userId,
        JSON.stringify(input.executableJson ?? {}),
      ],
    );
  }
  await admin.query(
    `insert into app.workflow_version_dependencies
     (workspace_id,parent_version_id,node_id,target_workflow_id,target_version_id)
     values($1,$2,'call',$3,$4)`,
    [workspaceId, parentVersionId, childWorkflowId, childVersionId],
  );
  for (const [runId, workflowId, versionId, age] of [
    [parentRunId, parentWorkflowId, parentVersionId, input.parentDays],
    [childRunId, childWorkflowId, childVersionId, input.childDays],
  ] as const) {
    const createdAt = daysAgo((age ?? 0) + 40);
    let runStatus: 'queued' | 'waiting' | 'succeeded';
    if (age === undefined) {
      if (runId === childRunId && input.childQueued === true) {
        runStatus = 'queued';
      } else {
        runStatus = 'waiting';
      }
    } else {
      runStatus = 'succeeded';
    }
    await admin.query(
      `insert into app.workflow_runs
       (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,input_ref,
        input_ref_expires_at,output_ref,created_at,started_at,completed_at)
       values($1,$2,$3,$4,'manual',$5,$6::jsonb,$7,$8::jsonb,$9,$9,$10)`,
      [
        runId,
        workspaceId,
        workflowId,
        versionId,
        runStatus,
        inline({ input: runId }),
        new Date(createdAt.getTime() + 30 * 86_400_000),
        age === undefined ? null : inline({ result: runId }),
        createdAt,
        age === undefined ? null : daysAgo(age),
      ],
    );
  }
  await admin.query(
    `insert into app.workflow_calls
     (id,workspace_id,parent_run_id,invocation_key,target_workflow_id,target_version_id,
      target_checksum,input_ref,input_checksum,status,child_run_id,live_child_run_id,
      result_ref,slot_lent,consumed_at,completed_at)
     values($1,$2,$3,'call',$4,$5,$6,$7::jsonb,$8,$9,$10,$10,$11::jsonb,$12,$13,$14)`,
    [
      callId,
      workspaceId,
      parentRunId,
      childWorkflowId,
      childVersionId,
      checksum,
      inline({ input: childRunId }),
      'a'.repeat(64),
      input.childDays === undefined ? 'accepted' : 'succeeded',
      childRunId,
      input.childDays === undefined ? null : inline({ result: childRunId }),
      input.slotLent ?? false,
      input.consumed === true ? daysAgo(input.parentDays ?? 0) : null,
      input.childDays === undefined ? null : daysAgo(input.childDays),
    ],
  );
  return {
    workspaceId,
    parentRunId,
    childRunId,
    callId,
    parentVersionId,
    childVersionId,
    childWorkflowId,
  };
}

export async function callRow(callId: string) {
  return (
    await admin.query<{
      child_run_id: string;
      live_child_run_id: string | null;
      input_ref: unknown;
      result_ref: unknown;
      details_purged_at: Date | null;
      status: string;
    }>('select * from app.workflow_calls where id=$1', [callId])
  ).rows[0];
}

export async function runRow(runId: string) {
  return (
    await admin.query<{
      input_ref: unknown;
      output_ref: unknown;
      details_purged_at: Date | null;
    }>(
      'select input_ref,output_ref,details_purged_at from app.workflow_runs where id=$1',
      [runId],
    )
  ).rows[0];
}

export async function insertBorrowedSlot(
  family: Awaited<ReturnType<typeof createFamily>>,
) {
  const outboxEventId = await insertHint(family.workspaceId, family.childRunId);
  await admin.query(
    `insert into app.workflow_run_active_admissions
     (workspace_id,workflow_run_id,outbox_event_id,borrowed_call_id)
     values($1,$2,$3,$4)`,
    [family.workspaceId, family.childRunId, outboxEventId, family.callId],
  );
  await admin.query(
    'update app.workflow_calls set slot_lent=true where id=$1',
    [family.callId],
  );
}

export async function insertHint(workspaceId: string, runId: string) {
  const outboxEventId = randomUUID();
  const payload = { workspaceId, runId, outboxEventId };
  await admin.query(
    `insert into app.outbox_events
     (id,workspace_id,job_name,aggregate_type,aggregate_id,payload,payload_checksum)
     values($1,$2,'advance-workflow-run','workflow-run',$3,$4::jsonb,$5)`,
    [
      outboxEventId,
      workspaceId,
      runId,
      JSON.stringify(payload),
      canonicalOutboxPayloadChecksum(payload),
    ],
  );
  return outboxEventId;
}
