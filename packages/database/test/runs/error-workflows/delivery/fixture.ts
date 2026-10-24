import { createTestRunStore } from '../../../support/run-advance-store.js';
import { canonicalOutboxPayloadChecksum } from '../../../../src/outbox/events.repository.js';

import { Pool } from 'pg';
import { expect } from 'vitest';
import {
  createCheckpoint,
  type WorkflowTransitionPlan,
} from '@pertexo/workflow-engine';
import { createErrorWorkflowStore } from '../../../../src/runs/error-workflows/store.js';
import { persistErrorWorkflowIntent } from '../../../../src/runs/error-workflows/produce.js';
import { parseDatabaseConfig } from '../../../../src/config.js';
import { withTenantScopedClient } from '../../../../src/tenant-access/transactions.js';
import { admin, createFamily } from '../../../lifecycle/calls/fixtures.js';

import { userId } from '../../../lifecycle/retention.support.js';
import { apiUrl } from '../../../lifecycle/retention.support.js';

export let pool: Pool;

export let store: ReturnType<typeof createErrorWorkflowStore>;

export async function fixture(
  status:
    | 'failed'
    | 'succeeded'
    | 'canceled'
    | 'timed_out'
    | 'outcome_unknown' = 'failed',
  origin = false,
  canceled = false,
) {
  const family = await createFamily({
    executableJson: {
      graph: {
        nodes: [
          {
            id: 'error',
            definition: { key: 'core.workflow_error', version: 1 },
            config: {},
          },
        ],
      },
    },
  });
  const source = (
    await admin.query<{ workflow_id: string }>(
      'select workflow_id from app.workflow_runs where id=$1',
      [family.parentRunId],
    )
  ).rows[0];
  if (source === undefined) throw new Error('Source missing');
  await admin.query(
    'update app.workflows set published_version_id=$2 where id=$1',
    [family.childWorkflowId, family.childVersionId],
  );
  await admin.query(
    'update app.workflow_runs set error_workflow_origin=$2 where id=$1',
    [family.parentRunId, origin],
  );
  await admin.query(
    'insert into app.workflow_error_policies(workspace_id,workflow_id,target_workflow_id) values($1,$2,$3)',
    [family.workspaceId, source.workflow_id, family.childWorkflowId],
  );
  const checkpoint = {
    ...createCheckpoint({
      workflowVersionId: family.parentVersionId,
      iterationBudget: 200,
    }),
    runStatus: status,
  };
  const plan: WorkflowTransitionPlan = {
    expectedRevision: 0,
    expectedNextEventSequence: 1,
    consumedThroughEventSequence: 0,
    checkpoint,
    events: [
      {
        name: `run.${status}`,
        sequence: 1,
        occurredAt: new Date().toISOString(),
      },
    ],
    nodeRunAdmissions: [],
    attempts: [],
  };
  const produce = () =>
    withTenantScopedClient(
      pool,
      { workspaceId: family.workspaceId },
      (client) =>
        persistErrorWorkflowIntent(client, {
          workspaceId: family.workspaceId,
          workflowId: source.workflow_id,
          workflowVersionId: family.parentVersionId,
          runId: family.parentRunId,
          cancellationRequested: canceled,
          plan,
        }),
    );
  return { ...family, sourceWorkflowId: source.workflow_id, produce };
}

export async function delivery(f: Awaited<ReturnType<typeof fixture>>) {
  const row = (
    await admin.query<{ id: string; payload_checksum: string }>(
      "select event.id,event.payload_checksum from app.outbox_events event join app.run_error_workflow_intents intent on intent.workspace_id=event.workspace_id and intent.outbox_event_id=event.id where event.workspace_id=$1 and event.aggregate_id=$2 and event.job_name='start-error-workflow'",
      [f.workspaceId, f.parentRunId],
    )
  ).rows[0];
  if (row === undefined) throw new Error('Missing delivery');
  return {
    workspaceId: f.workspaceId,
    sourceRunId: f.parentRunId,
    outboxEventId: row.id,
    payloadChecksum: row.payload_checksum,
    signal: new AbortController().signal,
  };
}

export async function intent(f: Awaited<ReturnType<typeof fixture>>) {
  return (
    await admin.query<{
      status: string;
      accepted_run_id: string | null;
      refusal_code: string | null;
      context: unknown;
      queue_wait_expires_at: Date | null;
      outbox_event_id: string;
    }>(
      'select status,accepted_run_id,refusal_code,context,queue_wait_expires_at,outbox_event_id from app.run_error_workflow_intents where workspace_id=$1 and source_run_id=$2',
      [f.workspaceId, f.parentRunId],
    )
  ).rows[0];
}

export async function publishManualTarget(
  f: Awaited<ReturnType<typeof fixture>>,
) {
  const nextVersionId = crypto.randomUUID();
  await admin.query(
    `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,executable_json,checksum,published_by)
      values($1,$2,$3,2,'{}',$4::jsonb,$5,$6)`,
    [
      nextVersionId,
      f.workspaceId,
      f.childWorkflowId,
      JSON.stringify({
        graph: {
          nodes: [{ definition: { key: 'core.manual', version: 1 } }],
        },
      }),
      `wf:sha256:${'b'.repeat(64)}`,
      userId,
    ],
  );
  await admin.query(
    'update app.workflows set published_version_id=$2 where id=$1',
    [f.childWorkflowId, nextVersionId],
  );
}

export async function fullQueue() {
  const f = await fixture();
  await f.produce();
  await admin.query(
    'insert into app.workspace_execution_entitlement_versions(workspace_id,version,active_run_limit,queued_run_limit) values($1,2,5,1)',
    [f.workspaceId],
  );
  await admin.query(
    'update app.workspace_execution_entitlements set current_version=2 where workspace_id=$1',
    [f.workspaceId],
  );
  const blocker = crypto.randomUUID();
  await admin.query(
    `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status) values($1,$2,$3,$4,'manual','queued')`,
    [blocker, f.workspaceId, f.childWorkflowId, f.childVersionId],
  );
  return { ...f, blocker };
}

export async function cancelQueuedRun(
  f: Awaited<ReturnType<typeof fullQueue>>,
) {
  const checkpoint = createCheckpoint({
    workflowVersionId: f.childVersionId,
    iterationBudget: 200,
  });
  const outboxEventId = crypto.randomUUID();
  const payload = {
    workspaceId: f.workspaceId,
    runId: f.blocker,
    outboxEventId,
  };
  const payloadChecksum = canonicalOutboxPayloadChecksum(payload);
  await admin.query(
    `insert into app.run_checkpoints(workspace_id,workflow_run_id,workflow_version_id,revision,scheduler_state)
    values($1,$2,$3,0,$4::jsonb)`,
    [f.workspaceId, f.blocker, f.childVersionId, JSON.stringify(checkpoint)],
  );
  await admin.query(
    `insert into app.outbox_events(id,workspace_id,job_name,aggregate_type,aggregate_id,payload,payload_checksum)
    values($1,$2,'advance-workflow-run','workflow-run',$3,$4::jsonb,$5)`,
    [
      outboxEventId,
      f.workspaceId,
      f.blocker,
      JSON.stringify(payload),
      payloadChecksum,
    ],
  );
  const coordinator = createTestRunStore(
    parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
  );
  try {
    expect(
      await coordinator.commitAdvancePlan({
        workspaceId: f.workspaceId,
        runId: f.blocker,
        delivery: { outboxEventId, payloadChecksum },
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 1,
          consumedThroughEventSequence: 0,
          checkpoint: {
            ...checkpoint,
            revision: 1,
            runStatus: 'canceled',
            nextEventSequence: 2,
          },
          events: [
            {
              name: 'run.canceled',
              sequence: 1,
              occurredAt: new Date().toISOString(),
            },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).toMatchObject({ kind: 'committed' });
  } finally {
    await coordinator.close();
  }
}

export function beforeAllFixture1() {
  pool = new Pool({ connectionString: apiUrl, max: 2 });
  store = createErrorWorkflowStore(
    parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
    (version) => ({
      checkpoint: createCheckpoint({
        workflowVersionId: version.id,
        iterationBudget: 200,
        nextEventSequence: 2,
      }),
    }),
  );
}

export async function afterAllFixture2() {
  await Promise.all([pool.end(), store.close()]);
}
