import { JOB_NAME } from '@pertexo/queue';
import type { QueueProducer } from '@pertexo/queue';

import type { Queue } from 'bullmq';
import { describe } from 'vitest';

import type { createHttpNodeAttemptProofRuntime } from '../../support/attempts/http-node-attempt.runtime.js';

import {
  acceptProviderScenarioRun,
  attemptDelivery,
  continuation,
  httpNodeAttemptIntegrationEnabled,
  resetProviderScenarioIsolation,
  seedFixture,
  waitFor,
  workerQuery,
  workspaceId,
} from '../../support/attempts/http-node-attempt.js';

export const describeIntegration = httpNodeAttemptIntegrationEnabled
  ? describe
  : describe.skip;

export let fixtureEncryption:
  Awaited<ReturnType<typeof seedFixture>> | undefined;

type PersistedQueueJob = NonNullable<Awaited<ReturnType<Queue['getJob']>>>;

type ProofRuntime = Awaited<
  ReturnType<typeof createHttpNodeAttemptProofRuntime>
>;

export function createOwnedBarrier(label: string, timeoutMillis = 5_000) {
  let settled = false;
  let resolvePromise!: () => void;
  let rejectPromise!: (error: Error) => void;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectPromise(new Error(`${label} timed out`));
  }, timeoutMillis);
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);
  const settle = (operation: () => void): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    operation();
  };
  return Object.freeze({
    promise,
    resolve: () => {
      settle(resolvePromise);
    },
    dispose: () => {
      settle(() => {
        rejectPromise(new Error(`${label} was disposed`));
      });
    },
  });
}

export async function readAttemptRedeliverySnapshot(input: {
  artifactId: string;
  attemptId: string;
  messageId: string;
  runId: string;
}) {
  return workerQuery<{
    artifact_count: string;
    attempt_dispatch_marked_at: Date | null;
    attempt_fence_token: string;
    attempt_output_ref: unknown;
    attempt_provider_idempotency_key: string | null;
    attempt_side_effect_class: string;
    attempt_status: string;
    event_count: string;
    node_output_ref: unknown;
    node_provider_idempotency_key: string | null;
    node_side_effect_class: string;
    node_status: string;
    receipt_count: string;
    usage_count: string;
  }>(
    `select attempt.status attempt_status,
            attempt.fence_token::text attempt_fence_token,
            attempt.dispatch_marked_at attempt_dispatch_marked_at,
            attempt.output_ref attempt_output_ref,
            attempt.side_effect_class attempt_side_effect_class,
            attempt.provider_idempotency_key attempt_provider_idempotency_key,
            node.status node_status,
            node.output_ref node_output_ref,
            node.side_effect_class node_side_effect_class,
            node.provider_idempotency_key node_provider_idempotency_key,
            (select count(*)::text from app.run_events event
              where event.workspace_id=attempt.workspace_id
                and event.workflow_run_id=$2) event_count,
            (select count(*)::text from app.inbox_receipts receipt
              where receipt.workspace_id=attempt.workspace_id
                and receipt.message_id=$3) receipt_count,
            (select count(*)::text from app.usage_events usage
              where usage.workspace_id=attempt.workspace_id
                and usage.resource_id=$2) usage_count,
            (select count(*)::text from app.artifacts artifact
              where artifact.workspace_id=attempt.workspace_id
                and artifact.id=$5) artifact_count
       from app.node_attempts attempt
       join app.node_runs node
         on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
      where attempt.workspace_id=$1 and attempt.id=$4`,
    [
      workspaceId,
      input.runId,
      input.messageId,
      input.attemptId,
      input.artifactId,
    ],
  );
}

export async function readArtifactIds(): Promise<Set<string>> {
  const rows = await workerQuery<{ id: string }>(
    `select id from app.artifacts where workspace_id=$1 order by id`,
    [workspaceId],
  );
  return new Set(rows.map(({ id }) => id));
}

export async function readSourceRunHistory(runId: string) {
  const [run, nodes, attempts, checkpoint, events] = await Promise.all([
    workerQuery(
      `select id,status,workflow_id,workflow_version_id,trigger_type,
              completed_at,cancel_requested_at,deadline_at
         from app.workflow_runs
        where workspace_id=$1 and id=$2`,
      [workspaceId, runId],
    ),
    workerQuery(
      `select id,node_id,status,current_attempt_id,current_attempt_number,
              side_effect_class,provider_idempotency_key,output_ref
         from app.node_runs
        where workspace_id=$1 and workflow_run_id=$2
        order by node_id,id`,
      [workspaceId, runId],
    ),
    workerQuery(
      `select attempt.id,attempt.node_run_id,attempt.attempt_number,
              attempt.status,attempt.fence_token::text fence_token,
              attempt.side_effect_class,attempt.provider_idempotency_key,
              attempt.output_ref,attempt.retry_decision,attempt.safe_error_code
         from app.node_attempts attempt
         join app.node_runs node
           on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
        where attempt.workspace_id=$1 and node.workflow_run_id=$2
        order by node.node_id,attempt.attempt_number,attempt.id`,
      [workspaceId, runId],
    ),
    workerQuery(
      `select revision,scheduler_state
         from app.run_checkpoints
        where workspace_id=$1 and workflow_run_id=$2`,
      [workspaceId, runId],
    ),
    workerQuery(
      `select sequence,type,payload
         from app.run_events
        where workspace_id=$1 and workflow_run_id=$2
        order by sequence`,
      [workspaceId, runId],
    ),
  ]);
  return { attempts, checkpoint, events, nodes, run };
}

export async function publishAndWaitForCompletion(
  producer: QueueProducer,
  queue: Queue,
  job: Parameters<QueueProducer['publish']>[0],
  label: string,
): Promise<PersistedQueueJob> {
  const published = await producer.publish(job);
  const persisted = await waitFor(
    () => queue.getJob(published.jobId),
    (candidate) => candidate !== undefined,
  );
  if (persisted === undefined)
    throw new Error(`${label} job was not persisted`);
  await waitFor(
    () => persisted.getState(),
    (state) => state === 'completed' || state === 'failed',
  );
  const state = await persisted.getState();
  if (state !== 'completed') {
    const refreshed = await queue.getJob(published.jobId);
    throw new Error(
      `${label} job ${state}: ${refreshed?.failedReason ?? 'unknown reason'}`,
    );
  }
  return persisted;
}

export function attemptJob(
  runId: string,
  attempt: Awaited<ReturnType<typeof attemptDelivery>>,
) {
  return {
    name: JOB_NAME.executeNodeAttempt,
    data: {
      workspaceId,
      runId,
      nodeRunId: attempt.node_run_id,
      attemptId: attempt.attempt_id,
      outboxEventId: attempt.outbox_id,
    },
  };
}

export async function admitProviderScenario(
  runtime: ProofRuntime,
  provider: 'email' | 'http' | 'http_post' | 'slack',
) {
  const accepted = await acceptProviderScenarioRun(provider);
  const coordinatorOutboxes = [accepted.outboxEventId];
  await Promise.all([
    runtime.coordinator.consumer.waitUntilReady(5_000),
    runtime.attempts.consumer.waitUntilReady(5_000),
    runtime.producer.waitUntilReady(5_000),
  ]);
  await publishAndWaitForCompletion(
    runtime.producer,
    runtime.coordinatorQueue,
    {
      name: JOB_NAME.advanceWorkflowRun,
      data: {
        workspaceId,
        runId: accepted.runId,
        outboxEventId: accepted.outboxEventId,
      },
    },
    `${provider} scenario initial coordinator`,
  );
  const manual = await attemptDelivery(accepted.runId, 'manual');
  await publishAndWaitForCompletion(
    runtime.producer,
    runtime.attemptQueue,
    attemptJob(accepted.runId, manual),
    `${provider} scenario manual attempt`,
  );
  const admissionOutbox = await continuation(
    accepted.runId,
    coordinatorOutboxes,
  );
  coordinatorOutboxes.push(admissionOutbox);
  await publishAndWaitForCompletion(
    runtime.producer,
    runtime.coordinatorQueue,
    {
      name: JOB_NAME.advanceWorkflowRun,
      data: {
        workspaceId,
        runId: accepted.runId,
        outboxEventId: admissionOutbox,
      },
    },
    `${provider} scenario provider admission`,
  );
  return {
    accepted,
    attempt: await attemptDelivery(accepted.runId, 'provider'),
    coordinatorOutboxes,
  };
}

export async function advanceScenario(
  runtime: ProofRuntime,
  runId: string,
  coordinatorOutboxes: string[],
  label: string,
): Promise<void> {
  const outboxEventId = await continuation(runId, coordinatorOutboxes);
  coordinatorOutboxes.push(outboxEventId);
  await publishAndWaitForCompletion(
    runtime.producer,
    runtime.coordinatorQueue,
    {
      name: JOB_NAME.advanceWorkflowRun,
      data: {
        workspaceId,
        runId,
        outboxEventId,
      },
    },
    label,
  );
}

export async function prepareAmbiguousEmailRetry(runtime: ProofRuntime) {
  const scenario = await admitProviderScenario(runtime, 'email');
  await publishAndWaitForCompletion(
    runtime.producer,
    runtime.attemptQueue,
    attemptJob(scenario.accepted.runId, scenario.attempt),
    'Initial ambiguous email attempt',
  );
  await advanceScenario(
    runtime,
    scenario.accepted.runId,
    scenario.coordinatorOutboxes,
    'Ambiguous email retry decision',
  );
  const retryDue = await waitFor(
    () =>
      workerQuery<{ retry_due_at: Date | null }>(
        `select retry_due_at from app.node_runs
           where workspace_id=$1 and workflow_run_id=$2 and node_id='provider'`,
        [workspaceId, scenario.accepted.runId],
      ),
    (rows) => rows[0]?.retry_due_at instanceof Date,
  );
  const retryDueAt = retryDue[0]?.retry_due_at;
  if (retryDueAt === null || retryDueAt === undefined)
    throw new Error('Ambiguous email retry due time missing');
  const delayMillis = retryDueAt.getTime() - Date.now();
  if (delayMillis > 0)
    await new Promise<void>((resolve) => setTimeout(resolve, delayMillis + 25));
  await advanceScenario(
    runtime,
    scenario.accepted.runId,
    scenario.coordinatorOutboxes,
    'Ambiguous email retry due admission',
  );
  return {
    ...scenario,
    retry: await attemptDelivery(scenario.accepted.runId, 'provider', 2),
  };
}

export async function closeProofRuntime(runtime: ProofRuntime): Promise<void> {
  const errors: unknown[] = [];
  const attempt = async (operation: () => unknown): Promise<void> => {
    await Promise.resolve()
      .then(operation)
      .catch((error: unknown) => {
        errors.push(error);
      });
  };
  await attempt(() => runtime.attempts.close());
  await attempt(() => runtime.coordinator.close());
  await attempt(() => runtime.producer.close());
  await attempt(() => runtime.attemptQueue.close());
  await attempt(() => runtime.coordinatorQueue.close());
  await attempt(async () => {
    await runtime.capabilities.close();
  });
  await attempt(() => {
    runtime.artifactVerifier.close();
  });
  if (errors.length > 0)
    throw new AggregateError(
      errors,
      'HTTP attempt proof runtime cleanup failed',
    );
}

export async function prepareHttpIntegrationTestTsFixture() {
  fixtureEncryption = await seedFixture();
}

export async function resetHttpIntegrationTestTsFixture() {
  if (!httpNodeAttemptIntegrationEnabled) return;
  await resetProviderScenarioIsolation();
}
