import { createHash } from 'node:crypto';
import { JOB_NAME } from '@pertexo/queue';
import { expect } from 'vitest';

import {
  attemptDelivery,
  continuation,
  emailConnectionId,
  emailRecipient,
  emailSecretVersionId,
  emailSubject,
  emailText,
  resendApiKey,
  waitFor,
  workerQuery,
  workspaceId,
} from '../../../../support/attempts/http-node-attempt.js';

import type { ArtifactScenario } from './context.js';

export async function proveArtifactEmailRetry(scenario: ArtifactScenario) {
  const {
    accepted,
    coordinatorOutboxes,
    attemptQueue,
    coordinatorQueue,
    emailRequests,
    producer,
  } = scenario;
  const emailContinuation = await continuation(
    accepted.runId,
    coordinatorOutboxes,
  );
  coordinatorOutboxes.push(emailContinuation);
  await producer.publish({
    name: JOB_NAME.advanceWorkflowRun,
    data: {
      workspaceId,
      runId: accepted.runId,
      outboxEventId: emailContinuation,
    },
  });
  const email = await attemptDelivery(accepted.runId, 'email');
  const emailDelivery = {
    name: JOB_NAME.executeNodeAttempt,
    data: {
      workspaceId,
      runId: accepted.runId,
      nodeRunId: email.node_run_id,
      attemptId: email.attempt_id,
      outboxEventId: email.outbox_id,
    },
  };
  const emailJob = await producer.publish(emailDelivery);
  const firstEmailAttempt = await waitFor(
    () =>
      workerQuery<{
        attempt_status: string;
        dispatch_marked_at: Date | null;
        executor_failure_kind: string | null;
        executor_possibly_dispatched: boolean | null;
        node_status: string;
        output_ref: unknown;
        provider_dispatch_binding: string | null;
        provider_idempotency_key: string | null;
        retry_decision: string | null;
      }>(
        `select attempt.status attempt_status,attempt.dispatch_marked_at,
                     attempt.provider_idempotency_key,node.status node_status,
                     node.provider_dispatch_binding,
                     attempt.output_ref,attempt.executor_failure_kind,
                     attempt.executor_possibly_dispatched,
                     attempt.retry_decision
             from app.node_attempts attempt
             join app.node_runs node
               on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
             where attempt.workspace_id=$1 and attempt.id=$2`,
        [workspaceId, email.attempt_id],
      ),
    (rows) => rows[0]?.attempt_status === 'failed',
  );
  expect(firstEmailAttempt[0]?.dispatch_marked_at).toBeInstanceOf(Date);
  expect(firstEmailAttempt[0]?.executor_failure_kind).toBe('retry');
  expect(firstEmailAttempt[0]?.executor_possibly_dispatched).toBe(false);
  expect(firstEmailAttempt[0]?.retry_decision).toBe('pending');
  const retryContinuation = await continuation(
    accepted.runId,
    coordinatorOutboxes,
  );
  coordinatorOutboxes.push(retryContinuation);
  const retryCoordinatorJob = await producer.publish({
    name: JOB_NAME.advanceWorkflowRun,
    data: {
      workspaceId,
      runId: accepted.runId,
      outboxEventId: retryContinuation,
    },
  });
  const persistedRetryCoordinatorJob = await waitFor(
    () => coordinatorQueue.getJob(retryCoordinatorJob.jobId),
    (job) => job !== undefined,
  );
  if (persistedRetryCoordinatorJob === undefined)
    throw new Error('Email retry coordinator job missing');
  await waitFor(
    () => persistedRetryCoordinatorJob.getState(),
    (state) => state === 'completed',
  );
  await waitFor(
    () =>
      workerQuery<{ retry_decision: string | null }>(
        `select retry_decision from app.node_attempts
             where workspace_id=$1 and id=$2`,
        [workspaceId, email.attempt_id],
      ),
    (rows) => rows[0]?.retry_decision === 'retry',
  );
  const dueContinuation = await continuation(
    accepted.runId,
    coordinatorOutboxes,
  );
  coordinatorOutboxes.push(dueContinuation);
  const dueCoordinatorJob = await producer.publish({
    name: JOB_NAME.advanceWorkflowRun,
    data: {
      workspaceId,
      runId: accepted.runId,
      outboxEventId: dueContinuation,
    },
  });
  const persistedDueCoordinatorJob = await waitFor(
    () => coordinatorQueue.getJob(dueCoordinatorJob.jobId),
    (job) => job !== undefined,
  );
  if (persistedDueCoordinatorJob === undefined)
    throw new Error('Email due coordinator job missing');
  await waitFor(
    () => persistedDueCoordinatorJob.getState(),
    (state) => state === 'completed',
  );
  const retriedEmail = await attemptDelivery(accepted.runId, 'email', 2);
  const retriedEmailDelivery = {
    name: JOB_NAME.executeNodeAttempt,
    data: {
      workspaceId,
      runId: accepted.runId,
      nodeRunId: retriedEmail.node_run_id,
      attemptId: retriedEmail.attempt_id,
      outboxEventId: retriedEmail.outbox_id,
    },
  };
  const retriedEmailJob = await producer.publish(retriedEmailDelivery);
  const emailTerminal = await waitFor(
    () =>
      workerQuery<{
        attempt_status: string;
        dispatch_marked_at: Date | null;
        node_status: string;
        output_ref: unknown;
        provider_dispatch_binding: string | null;
        provider_idempotency_key: string | null;
      }>(
        `select attempt.status attempt_status,attempt.dispatch_marked_at,
                    attempt.provider_idempotency_key,node.status node_status,
                    node.provider_dispatch_binding,
                    attempt.output_ref
             from app.node_attempts attempt
             join app.node_runs node
               on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
             where attempt.workspace_id=$1 and attempt.id=$2`,
        [workspaceId, retriedEmail.attempt_id],
      ),
    (rows) => rows[0]?.attempt_status === 'succeeded',
  );
  expect(emailTerminal[0]).toMatchObject({
    attempt_status: 'succeeded',
    node_status: 'succeeded',
    output_ref: {
      kind: 'inline',
      value: { emailId: '49b9a1e5-3f0c-4e68-882d-fbc91c0d4ec2' },
    },
  });
  expect(emailTerminal[0]?.dispatch_marked_at).toBeInstanceOf(Date);
  expect(emailTerminal[0]?.provider_idempotency_key).toMatch(
    /^v1\.[0-9a-f]{64}$/u,
  );
  expect(emailTerminal[0]?.provider_dispatch_binding).toBe(
    `email:sha256:${createHash('sha256')
      .update(`email\0${emailConnectionId}\0${emailSecretVersionId}`)
      .digest('hex')}`,
  );
  expect(emailTerminal[0]?.provider_dispatch_binding).not.toContain(
    'sender@example.test',
  );
  expect(emailRequests).toHaveLength(2);
  expect(emailRequests[0]).toEqual({
    apiKey: resendApiKey,
    fromEmail: 'sender@example.test',
    toEmail: emailRecipient,
    subject: emailSubject,
    text: emailText,
    idempotencyKey: emailTerminal[0]?.provider_idempotency_key,
  });
  expect(emailRequests[1]).toEqual(emailRequests[0]);
  const completedEmailJob = await waitFor(
    () => attemptQueue.getJob(emailJob.jobId),
    (job) => job !== undefined,
  );
  if (completedEmailJob === undefined) throw new Error('Email job missing');
  await waitFor(
    () => completedEmailJob.getState(),
    (state) => state === 'completed',
  );
  await waitFor(
    () => attemptQueue.getJob(retriedEmailJob.jobId),
    (job) => job !== undefined,
  );
  await completedEmailJob.remove();
  await producer.publish(emailDelivery);
  const replayedEmailJob = await waitFor(
    () => attemptQueue.getJob(emailJob.jobId),
    (job) => job !== undefined,
  );
  if (replayedEmailJob === undefined)
    throw new Error('redelivered email job missing');
  await waitFor(
    () => replayedEmailJob.getState(),
    (state) => state === 'completed',
  );
  expect(emailRequests).toHaveLength(2);

  return { emailDelivery, replayedEmailJob };
}
