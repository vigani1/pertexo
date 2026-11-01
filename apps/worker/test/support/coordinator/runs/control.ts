import { randomUUID } from 'node:crypto';
import { createRunAdvanceStore } from '@pertexo/core/testing';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { createWorkflowRunDatabase } from '@pertexo/core/runs';

import {
  createCheckpoint,
  invocationKey,
  parseCheckpoint,
  type WorkflowTransitionPlan,
} from '@pertexo/workflow-engine';

import { expect } from 'vitest';

import {
  actorId,
  databaseUrl,
  apiUrl,
  workerQuery,
  workerUrl,
  workflowVersionId,
  workspaceId,
} from './scope.js';
import type { AcceptedRun } from './contract.js';

export async function cancelFixtureRun(
  runId: string,
  reason: string,
): Promise<void> {
  const database = createWorkflowRunDatabase(
    parseDatabaseConfig({
      connectionString: databaseUrl(apiUrl),
      max: 2,
    }),
  );
  try {
    await database.cancel({
      actorId,
      workspaceId,
      runId,
      reason,
      requestId: `for-each-cancel-${randomUUID()}`,
    });
  } finally {
    await database.close();
  }
}

export async function terminalizeFailedRun(accepted: AcceptedRun): Promise<
  Readonly<{
    intentId: string;
    outboxEventId: string;
    payloadChecksum: string;
  }>
> {
  const { runId } = accepted;
  const failedInvocationKey = invocationKey({
    workflowVersionId,
    nodeId: 'set',
  });
  const nodeRunId = randomUUID();
  const attemptId = randomUUID();
  const running = {
    ...createCheckpoint({
      workflowVersionId,
      iterationBudget: 0,
      nextEventSequence: 2,
    }),
    runStatus: 'running' as const,
    admittedInvocationKeys: [failedInvocationKey],
    invocations: [
      {
        invocationKey: failedInvocationKey,
        nodeId: 'set',
        status: 'running' as const,
        attemptNumber: 1,
      },
    ],
  };
  await workerQuery(
    `with updated_run as (
       update app.workflow_runs set status='running',started_at=clock_timestamp()
        where workspace_id=$1 and id=$2
     ), updated_checkpoint as (
       update app.run_checkpoints set scheduler_state=$3::jsonb
        where workspace_id=$1 and workflow_run_id=$2
     ), node as (
       insert into app.node_runs (
         id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
         status,side_effect_class,current_attempt_id,current_attempt_number
       ) values ($4,$1,$2,'set',$5,'{}','running','safe',$6,1)
     )
     insert into app.node_attempts (
       id,workspace_id,node_run_id,attempt_number,status,side_effect_class,
       safe_error_code,executor_failure_kind,executor_error_kind,
       executor_possibly_dispatched,retry_decision
     ) values ($6,$1,$4,1,'failed','safe','provider.unavailable',
       'failed','provider',false,'pending')`,
    [
      workspaceId,
      runId,
      JSON.stringify(running),
      nodeRunId,
      failedInvocationKey,
      attemptId,
    ],
  );
  const store = createRunAdvanceStore(
    parseDatabaseConfig({ connectionString: databaseUrl(workerUrl), max: 2 }),
  );
  try {
    const [acceptedDelivery] = await workerQuery<{
      id: string;
      payload_checksum: string;
    }>(
      `select id,payload_checksum from app.outbox_events
        where workspace_id=$1 and id=$2`,
      [workspaceId, accepted.outboxEventId],
    );
    if (acceptedDelivery === undefined)
      throw new Error('Accepted coordinator delivery is missing');
    const plan: WorkflowTransitionPlan = {
      expectedRevision: 0,
      expectedNextEventSequence: 2,
      consumedThroughEventSequence: 1,
      checkpoint: {
        ...createCheckpoint({
          workflowVersionId,
          iterationBudget: 0,
          nextEventSequence: 4,
        }),
        revision: 1,
        runStatus: 'failed' as const,
        admittedInvocationKeys: [failedInvocationKey],
        invocations: [
          {
            invocationKey: failedInvocationKey,
            nodeId: 'set',
            status: 'failed',
            attemptNumber: 1,
          },
        ],
      },
      events: [
        {
          sequence: 2,
          name: 'node.failed',
          occurredAt: '2026-08-24T10:01:00.000Z',
          invocationKey: failedInvocationKey,
          nodeId: 'set',
          attemptNumber: 1,
          reasonCode: 'provider.unavailable',
        },
        {
          sequence: 3,
          name: 'run.failed',
          occurredAt: '2026-08-24T10:01:00.000Z',
        },
      ],
      nodeRunAdmissions: [],
      attempts: [],
    };
    // Saves a hand-written failed transition through the real advance store.
    await expect(
      store.advance(
        {
          delivery: {
            outboxEventId: acceptedDelivery.id,
            payloadChecksum: acceptedDelivery.payload_checksum,
          },
          workspaceId,
          runId,
          signal: new AbortController().signal,
        },
        (state) =>
          Promise.resolve({
            kind: 'transition' as const,
            previous: parseCheckpoint(state.checkpoint),
            plan,
          }),
      ),
    ).resolves.toMatchObject({ kind: 'committed' });
  } finally {
    await store.close();
  }
  const [identity] = await workerQuery<{
    intent_id: string;
    outbox_event_id: string;
    payload_checksum: string;
  }>(
    `select intent.id intent_id,outbox.id outbox_event_id,outbox.payload_checksum
       from app.run_failure_notification_intents intent
       join app.outbox_events outbox on outbox.aggregate_id=intent.id
      where intent.workspace_id=$1 and intent.workflow_run_id=$2
        and outbox.job_name='deliver-run-failure-notification'`,
    [workspaceId, runId],
  );
  if (identity === undefined)
    throw new Error('Coordinator did not create a failure notification intent');
  return {
    intentId: identity.intent_id,
    outboxEventId: identity.outbox_event_id,
    payloadChecksum: identity.payload_checksum,
  };
}
