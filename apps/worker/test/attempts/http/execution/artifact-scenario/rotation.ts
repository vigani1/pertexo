import { createHash, randomUUID } from 'node:crypto';
import { JOB_NAME } from '@pertexo/queue';
import { expect } from 'vitest';

import {
  actorId,
  attemptDelivery,
  connectionStore,
  continuation,
  emailConnectionId,
  emailSecretVersionId,
  rotatedEmailSecretVersionId,
  rotatedResendApiKey,
  waitFor,
  workerQuery,
  workspaceId,
} from '../../../../support/attempts/http-node-attempt.js';

import type { ArtifactScenario } from './context.js';

export async function proveArtifactRotatedCredentialFence(
  scenario: ArtifactScenario,
) {
  const {
    encryption,
    accepted,
    coordinatorOutboxes,
    coordinatorQueue,
    emailRequests,
    producer,
  } = scenario;
  const rotatedAdmission = await continuation(
    accepted.runId,
    coordinatorOutboxes,
  );
  coordinatorOutboxes.push(rotatedAdmission);
  await producer.publish({
    name: JOB_NAME.advanceWorkflowRun,
    data: {
      workspaceId,
      runId: accepted.runId,
      outboxEventId: rotatedAdmission,
    },
  });
  const rotatedFirst = await attemptDelivery(accepted.runId, 'email-rotated');
  await producer.publish({
    name: JOB_NAME.executeNodeAttempt,
    data: {
      workspaceId,
      runId: accepted.runId,
      nodeRunId: rotatedFirst.node_run_id,
      attemptId: rotatedFirst.attempt_id,
      outboxEventId: rotatedFirst.outbox_id,
    },
  });
  await waitFor(
    () =>
      workerQuery<{ status: string }>(
        `select status from app.node_attempts
             where workspace_id=$1 and id=$2`,
        [workspaceId, rotatedFirst.attempt_id],
      ),
    (rows) => rows[0]?.status === 'failed',
  );
  expect(emailRequests).toHaveLength(3);

  const rotatedRetry = await continuation(accepted.runId, coordinatorOutboxes);
  coordinatorOutboxes.push(rotatedRetry);
  const rotatedRetryJob = await producer.publish({
    name: JOB_NAME.advanceWorkflowRun,
    data: {
      workspaceId,
      runId: accepted.runId,
      outboxEventId: rotatedRetry,
    },
  });
  const persistedRotatedRetryJob = await waitFor(
    () => coordinatorQueue.getJob(rotatedRetryJob.jobId),
    (job) => job !== undefined,
  );
  if (persistedRotatedRetryJob === undefined)
    throw new Error('Rotated email retry coordinator job missing');
  await waitFor(
    () => persistedRotatedRetryJob.getState(),
    (state) => state === 'completed',
  );

  const rotatedSecret = new TextEncoder().encode(
    JSON.stringify({
      type: 'resend_api_key',
      apiKey: rotatedResendApiKey,
      fromEmail: 'sender@example.test',
    }),
  );
  const sealedRotatedSecret = await encryption.seal(rotatedSecret, {
    workspaceId,
    connectionId: emailConnectionId,
    secretVersionId: rotatedEmailSecretVersionId,
  });
  rotatedSecret.fill(0);
  if (connectionStore === undefined)
    throw new Error('Connection database missing');
  await connectionStore.rotateConnectionSecret({
    workspaceId,
    actorId,
    connectionId: emailConnectionId,
    secretVersionId: rotatedEmailSecretVersionId,
    expectedCurrentSecretVersionId: emailSecretVersionId,
    expectedAuthType: 'resend_api_key',
    sealed: sealedRotatedSecret,
    idempotencyKey: randomUUID(),
    requestHash: createHash('sha256').update(randomUUID()).digest('hex'),
  });

  const rotatedDue = await continuation(accepted.runId, coordinatorOutboxes);
  coordinatorOutboxes.push(rotatedDue);
  await producer.publish({
    name: JOB_NAME.advanceWorkflowRun,
    data: {
      workspaceId,
      runId: accepted.runId,
      outboxEventId: rotatedDue,
    },
  });
  const rotatedSecond = await attemptDelivery(
    accepted.runId,
    'email-rotated',
    2,
  );
  await producer.publish({
    name: JOB_NAME.executeNodeAttempt,
    data: {
      workspaceId,
      runId: accepted.runId,
      nodeRunId: rotatedSecond.node_run_id,
      attemptId: rotatedSecond.attempt_id,
      outboxEventId: rotatedSecond.outbox_id,
    },
  });
  const rotatedTerminal = await waitFor(
    () =>
      workerQuery<{
        attempt_status: string;
        dispatch_marked_at: Date | null;
        executor_failure_kind: string | null;
        executor_possibly_dispatched: boolean | null;
        node_status: string;
      }>(
        `select attempt.status attempt_status,attempt.dispatch_marked_at,
                    attempt.executor_failure_kind,
                    attempt.executor_possibly_dispatched,
                    node.status node_status
             from app.node_attempts attempt
             join app.node_runs node
               on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
             where attempt.workspace_id=$1 and attempt.id=$2`,
        [workspaceId, rotatedSecond.attempt_id],
      ),
    (rows) => rows[0]?.executor_failure_kind === 'outcome_unknown',
  );
  expect(rotatedTerminal[0]).toMatchObject({
    attempt_status: 'failed',
    dispatch_marked_at: null,
    executor_failure_kind: 'outcome_unknown',
    executor_possibly_dispatched: true,
    node_status: 'running',
  });
  expect(emailRequests).toHaveLength(3);
  const rotatedTerminalContinuation = await continuation(
    accepted.runId,
    coordinatorOutboxes,
  );
  coordinatorOutboxes.push(rotatedTerminalContinuation);
  await producer.publish({
    name: JOB_NAME.advanceWorkflowRun,
    data: {
      workspaceId,
      runId: accepted.runId,
      outboxEventId: rotatedTerminalContinuation,
    },
  });
  await waitFor(
    () =>
      workerQuery<{ status: string }>(
        `select status from app.node_runs
             where workspace_id=$1 and id=$2`,
        [workspaceId, rotatedSecond.node_run_id],
      ),
    (rows) => rows[0]?.status === 'outcome_unknown',
  );
  expect(emailRequests).toHaveLength(3);
}
