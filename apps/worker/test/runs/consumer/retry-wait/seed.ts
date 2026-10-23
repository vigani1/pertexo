import { createHash, randomUUID } from 'node:crypto';

import { QUEUE_NAME } from '@pertexo/queue';
import { invocationKey } from '@pertexo/workflow-engine';
import { Queue } from 'bullmq';
import { Pool } from 'pg';

import { coordinatorFixture } from '../../../support/coordinator/consumer.js';

import {
  adminUrl,
  apiQuery,
  databaseUrl,
  redisConnection,
  workflowId,
  workflowVersionId,
  workspaceId,
} from './fixture.js';

export async function seedDueWakeups() {
  const coordinatorQueue = new Queue(QUEUE_NAME.workflowCoordinator, {
    connection: redisConnection(),
  });
  try {
    await coordinatorQueue.obliterate({ force: true });
  } finally {
    await coordinatorQueue.close();
  }
  const fixtureAdmin = new Pool({
    connectionString: databaseUrl(adminUrl),
    max: 1,
  });
  try {
    await fixtureAdmin.query(
      `update app.outbox_events
           set published_at=coalesce(published_at,clock_timestamp())
           where job_name='advance-workflow-run'`,
    );
  } finally {
    await fixtureAdmin.end();
  }
  const runId = randomUUID();
  const nodeIds = ['manual', 'set'] as const;
  const invocationKeys = nodeIds.map((nodeId) =>
    invocationKey({ workflowVersionId, nodeId }),
  );
  const providerKeys = nodeIds.map(
    (nodeId) => `due-wakeup-provider-key:${runId}:${nodeId}`,
  );
  const nodeRunIds = nodeIds.map(() => randomUUID());
  const firstAttemptIds = nodeIds.map(() => randomUUID());
  const dueAt = new Date(Date.now() + 60_000).toISOString();
  const waitingCheckpoint = {
    workflowVersionId,
    revision: 0,
    runStatus: 'waiting' as const,
    nextEventSequence: 2,
    readySet: [],
    admittedInvocationKeys: invocationKeys,
    invocations: nodeIds.map((nodeId) => ({
      invocationKey: invocationKey({ workflowVersionId, nodeId }),
      nodeId,
      status: 'waiting' as const,
      attemptNumber: 1,
      resumeAt: dueAt,
      waitKind:
        nodeId === 'manual'
          ? ('retry_backoff' as const)
          : ('node_wait' as const),
      ...(nodeId === 'set'
        ? {
            output: {
              kind: 'inline' as const,
              attemptId: firstAttemptIds[1] as string,
            },
          }
        : {}),
    })),
    joins: [],
    loops: [],
    remainingIterationBudget: 0,
    cancelRequested: false,
    deadlineExpired: false,
    branchSelections: [],
  };
  await apiQuery(
    `insert into app.workflow_runs (
           id,workspace_id,workflow_id,workflow_version_id,trigger_type,status
         ) values ($1,$2,$3,$4,'manual','waiting')`,
    [runId, workspaceId, workflowId, workflowVersionId],
    { workflowId, keyHash: createHash('sha256').update(runId).digest('hex') },
  );
  await apiQuery(
    `insert into app.run_events
           (workspace_id,workflow_run_id,sequence,type,payload)
         values ($1,$2,1,'run.queued','{}'::jsonb)`,
    [workspaceId, runId],
  );
  await apiQuery(
    `insert into app.run_checkpoints (
           workflow_run_id,workspace_id,workflow_version_id,revision,scheduler_state
         ) values ($1,$2,$3,0,$4::jsonb)`,
    [runId, workspaceId, workflowVersionId, JSON.stringify(waitingCheckpoint)],
  );
  const seedClient = await coordinatorFixture.workerPool.connect();
  try {
    await seedClient.query('begin');
    await seedClient.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
    await seedClient.query('set constraints all deferred');
    for (const [index, nodeId] of nodeIds.entries()) {
      if (nodeId === 'manual') {
        await seedClient.query(
          `insert into app.node_runs (
                id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
                status,side_effect_class,provider_idempotency_key,current_attempt_id,
                current_attempt_number,retry_due_at,wait_kind
              ) values ($1,$2,$3,$4,$5,'{}','waiting','idempotent_with_key',$6,$7,1,$8,
                        'retry_backoff')`,
          [
            nodeRunIds[index],
            workspaceId,
            runId,
            nodeId,
            invocationKeys[index],
            providerKeys[index],
            firstAttemptIds[index],
            dueAt,
          ],
        );
        await seedClient.query(
          `insert into app.node_attempts (
                id,workspace_id,node_run_id,attempt_number,status,side_effect_class,
                provider_idempotency_key,safe_error_code,executor_failure_kind,
                executor_error_kind,executor_possibly_dispatched,retry_decision,
                completed_at
              ) values ($1,$2,$3,1,'failed','idempotent_with_key',$4,
                        'execution.rate_limit','retry','rate_limit',false,'retry',
                        clock_timestamp())`,
          [
            firstAttemptIds[index],
            workspaceId,
            nodeRunIds[index],
            providerKeys[index],
          ],
        );
      } else {
        const output = JSON.stringify({
          kind: 'inline',
          value: { preserved: true },
        });
        await seedClient.query(
          `insert into app.node_runs (
                id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,
                status,side_effect_class,current_attempt_id,current_attempt_number,
                resume_at,wait_kind,output_ref
              ) values ($1,$2,$3,$4,$5,'{}','waiting','safe',$6,1,$7,'node_wait',$8::jsonb)`,
          [
            nodeRunIds[index],
            workspaceId,
            runId,
            nodeId,
            invocationKeys[index],
            firstAttemptIds[index],
            dueAt,
            output,
          ],
        );
        await seedClient.query(
          `insert into app.node_attempts (
                id,workspace_id,node_run_id,attempt_number,status,side_effect_class,
                output_ref,completed_at
              ) values ($1,$2,$3,1,'succeeded','safe',$4::jsonb,clock_timestamp())`,
          [firstAttemptIds[index], workspaceId, nodeRunIds[index], output],
        );
      }
    }
    await seedClient.query('commit');
  } catch (error: unknown) {
    await seedClient.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    seedClient.release();
  }

  return { runId, nodeIds, providerKeys, waitingCheckpoint, dueAt };
}
