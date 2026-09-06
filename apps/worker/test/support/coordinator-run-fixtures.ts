import { createHash, randomUUID } from 'node:crypto';

import {
  acceptWorkflowRun,
  createCoordinatorRunStore,
  parseDatabaseConfig,
} from '@pertexo/database/testing';
import { createWorkflowRunDatabase } from '@pertexo/database/api';
import { platformRegistryReleaseSupport } from '@pertexo/node-catalog';
import {
  composeExecutableCompatibilityRelease,
  createCheckpoint,
  createCheckpointV2,
  createExecutableCompatibilityReleaseSupport,
  invocationKey,
} from '@pertexo/workflow-engine';
import { expect } from 'vitest';

import {
  JOB_NAME,
  QUEUE_NAME,
  Queue,
  apiDatabase,
  actorId,
  conditionWorkflowId,
  conditionWorkflowVersionId,
  createCoordinatorRuntime,
  createQueueProducer,
  databaseUrl,
  engineVersion,
  forEachWorkflowId,
  forEachWorkflowVersionId,
  apiUrl,
  nestedParallelWorkflowId,
  nestedParallelWorkflowVersionId,
  parallelWorkflowId,
  parallelWorkflowVersionId,
  redisConnection,
  redisUrl,
  switchWorkflowId,
  switchWorkflowVersionId,
  waitFor,
  workerQuery,
  workerUrl,
  workflowId,
  workflowVersionId,
  workspaceId,
} from '../coordinator-consumer.fixtures.js';

export interface AcceptedRun {
  readonly outboxEventId: string;
  readonly runId: string;
}

export interface AcceptedReplayRun extends AcceptedRun {
  readonly sourceRunId: string;
}

export interface CoordinatorRedeliveryHarness {
  publishInitial(): Promise<void>;
  redeliver(): Promise<void>;
  close(): Promise<void>;
}

export async function createCoordinatorRedeliveryHarness(
  accepted: AcceptedRun,
): Promise<CoordinatorRedeliveryHarness> {
  const runtime = await createCoordinatorRuntime({
    database: parseDatabaseConfig({
      connectionString: databaseUrl(workerUrl),
      max: 4,
    }),
    maximumAdmissions: 1,
    releaseCohort: 'for_each_activation',
    redisUrl,
  });
  const producer = createQueueProducer({ redisUrl });
  const queue = new Queue(QUEUE_NAME.workflowCoordinator, {
    connection: redisConnection(),
  });
  const job = {
    name: JOB_NAME.advanceWorkflowRun,
    data: {
      schemaVersion: 1 as const,
      workspaceId,
      runId: accepted.runId,
      outboxEventId: accepted.outboxEventId,
    },
  };
  let published: Awaited<ReturnType<typeof producer.publish>> | undefined;

  const close = async () => {
    await Promise.allSettled([
      producer.close(),
      runtime.close(),
      queue.close(),
    ]);
  };

  const publishInitial = async () => {
    await Promise.all([
      runtime.consumer.waitUntilReady(5_000),
      producer.waitUntilReady(5_000),
    ]);
    published = await producer.publish(job);
    const firstTransition = await waitFor(
      async () => {
        const [rows, queuedJob] = await Promise.all([
          workerQuery<{ revision: number }>(
            `select revision from app.run_checkpoints
               where workspace_id = $1 and workflow_run_id = $2`,
            [workspaceId, accepted.runId],
          ),
          queue.getJob(published?.jobId ?? ''),
        ]);
        return {
          revision: rows[0]?.revision,
          failedReason: queuedJob?.failedReason,
          state: await queuedJob?.getState(),
        };
      },
      (value) => value.revision === 1 || value.state === 'failed',
    );
    if (firstTransition.revision !== 1)
      throw new Error(
        `Coordinator redelivery failed: ${firstTransition.failedReason ?? 'unknown'}`,
      );
  };

  const redeliver = async () => {
    if (published === undefined) throw new Error('initial job is missing');
    const firstJob = await waitFor(
      () => queue.getJob(published?.jobId ?? ''),
      (value) => value !== undefined,
    );
    if (firstJob === undefined) throw new Error('initial job disappeared');
    await waitFor(
      () => firstJob.getState(),
      (state) => state === 'completed',
    );
    await firstJob.remove();
    await producer.publish(job);
    const replay = await waitFor(
      () => queue.getJob(published?.jobId ?? ''),
      (value) => value !== undefined,
    );
    if (replay === undefined) throw new Error('redelivered job disappeared');
    await waitFor(
      () => replay.getState(),
      (state) => state === 'completed',
    );
  };

  return { publishInitial, redeliver, close };
}

async function acceptFixtureRun(
  input: Readonly<{
    iterationBudget: number;
    workflowId: string;
    workflowVersionId: string;
  }>,
): Promise<AcceptedRun> {
  const checkpointInput = {
    engineVersion,
    workflowVersionId: input.workflowVersionId,
    iterationBudget: input.iterationBudget,
    nextEventSequence: 2,
  };
  return apiDatabase.withWorkspace(workspaceId, (transaction) =>
    acceptWorkflowRun(transaction, {
      engineVersion,
      initialCheckpoint:
        input.iterationBudget === 0
          ? createCheckpoint(checkpointInput)
          : createCheckpointV2(checkpointInput),
      keyHash: createHash('sha256').update(randomUUID()).digest('hex'),
      operation: 'workflow.run.accept',
      runInput: input.workflowId === workflowId ? { name: 'Ada' } : {},
      requestHash: createHash('sha256').update(randomUUID()).digest('hex'),
      scope: `coordinator:${input.workflowId}`,
      triggerType: 'manual',
      workflowId: input.workflowId,
      workflowVersionId: input.workflowVersionId,
    }),
  );
}

export function acceptRun(): Promise<AcceptedRun> {
  return acceptFixtureRun({
    iterationBudget: 0,
    workflowId,
    workflowVersionId,
  });
}

export async function acceptReplayRun(): Promise<AcceptedReplayRun> {
  const source = await acceptRun();
  const database = createWorkflowRunDatabase(
    parseDatabaseConfig({
      connectionString: databaseUrl(apiUrl),
      max: 2,
    }),
    createExecutableCompatibilityReleaseSupport(
      platformRegistryReleaseSupport('for_each_activation').map(
        composeExecutableCompatibilityRelease,
      ),
    ).descriptions,
  );
  try {
    const accepted = await database.replay({
      actorId,
      workspaceId,
      sourceRunId: source.runId,
      workflowVersionId,
      idempotencyKeyHash: createHash('sha256')
        .update(randomUUID())
        .digest('hex'),
      requestHash: createHash('sha256').update(randomUUID()).digest('hex'),
      scope: `workflow:${source.runId}:replay`,
      input: { name: 'Replay' },
      checkpointFactory: (projection) => ({
        engineVersion,
        checkpoint: createCheckpoint({
          engineVersion,
          workflowVersionId: projection.id,
          iterationBudget: 0,
          nextEventSequence: 2,
        }),
      }),
    });
    const outboxRows = await workerQuery<{ id: string }>(
      `select id from app.outbox_events
        where workspace_id=$1 and aggregate_id=$2
          and job_name='advance-workflow-run'`,
      [workspaceId, accepted.run.id],
    );
    const outboxEventId = outboxRows[0]?.id;
    if (outboxEventId === undefined)
      throw new Error('replay coordinator outbox missing');
    return {
      outboxEventId,
      runId: accepted.run.id,
      sourceRunId: source.runId,
    };
  } finally {
    await database.close();
  }
}

export function acceptConditionRun(): Promise<AcceptedRun> {
  return acceptFixtureRun({
    iterationBudget: 1_000,
    workflowId: conditionWorkflowId,
    workflowVersionId: conditionWorkflowVersionId,
  });
}

export function acceptSwitchRun(): Promise<AcceptedRun> {
  return acceptFixtureRun({
    iterationBudget: 1_000,
    workflowId: switchWorkflowId,
    workflowVersionId: switchWorkflowVersionId,
  });
}

export function acceptParallelRun(): Promise<AcceptedRun> {
  return acceptFixtureRun({
    iterationBudget: 1_000,
    workflowId: parallelWorkflowId,
    workflowVersionId: parallelWorkflowVersionId,
  });
}

export function acceptForEachRun(): Promise<AcceptedRun> {
  return acceptFixtureRun({
    iterationBudget: 1_000,
    workflowId: forEachWorkflowId,
    workflowVersionId: forEachWorkflowVersionId,
  });
}

export function acceptNestedParallelRun(): Promise<AcceptedRun> {
  return acceptFixtureRun({
    iterationBudget: 2,
    workflowId: nestedParallelWorkflowId,
    workflowVersionId: nestedParallelWorkflowVersionId,
  });
}

export async function waitForAttemptOutbox(
  runId: string,
  excludedIds: readonly string[] = [],
): Promise<{
  attemptId: string;
  nodeRunId: string;
  outboxEventId: string;
}> {
  const rows = await waitFor(
    () =>
      workerQuery<{
        attempt_id: string;
        id: string;
        node_run_id: string;
      }>(
        `select outbox.id,attempt.id attempt_id,node.id node_run_id
         from app.outbox_events outbox
         join app.node_attempts attempt
           on attempt.workspace_id=outbox.workspace_id
          and attempt.id=outbox.aggregate_id
         join app.node_runs node
           on node.workspace_id=attempt.workspace_id
          and node.id=attempt.node_run_id
         where outbox.workspace_id=$1 and node.workflow_run_id=$2
           and outbox.job_name='execute-node-attempt'
           and not (outbox.id=any($3::uuid[]))
         order by outbox.created_at,outbox.id`,
        [workspaceId, runId, excludedIds],
      ),
    (value) => value.length > 0,
  );
  const row = rows[0];
  if (row === undefined) throw new Error('attempt outbox missing');
  return {
    attemptId: row.attempt_id,
    nodeRunId: row.node_run_id,
    outboxEventId: row.id,
  };
}

export async function waitForCoordinatorOutbox(
  runId: string,
  excludedIds: readonly string[],
): Promise<string> {
  const rows = await waitFor(
    () =>
      workerQuery<{ id: string }>(
        `select id from app.outbox_events
         where workspace_id=$1 and aggregate_id=$2
           and job_name='advance-workflow-run'
           and not (id=any($3::uuid[]))
         order by created_at,id`,
        [workspaceId, runId, excludedIds],
      ),
    (value) => value.length > 0,
  );
  const row = rows[0];
  if (row === undefined) throw new Error('coordinator outbox missing');
  return row.id;
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
      engineVersion,
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
  const store = createCoordinatorRunStore(
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
    await expect(
      store.commitAdvancePlan({
        delivery: {
          outboxEventId: acceptedDelivery.id,
          payloadChecksum: acceptedDelivery.payload_checksum,
        },
        workspaceId,
        runId,
        workflowVersionId,
        signal: new AbortController().signal,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 1,
          checkpoint: {
            ...createCheckpoint({
              engineVersion,
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
              schemaVersion: 1,
              sequence: 2,
              name: 'node.failed',
              occurredAt: '2026-08-24T10:01:00.000Z',
              invocationKey: failedInvocationKey,
              nodeId: 'set',
              attemptNumber: 1,
              reasonCode: 'provider.unavailable',
            },
            {
              schemaVersion: 1,
              sequence: 3,
              name: 'run.failed',
              occurredAt: '2026-08-24T10:01:00.000Z',
            },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
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
