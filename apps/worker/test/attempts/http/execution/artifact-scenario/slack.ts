import { JOB_NAME } from '@pertexo/queue';
import { expect } from 'vitest';

import {
  attemptDelivery,
  continuation,
  slackBotToken,
  slackConnectionId,
  slackMessageText,
  waitFor,
  withOwner,
  workerQuery,
  workspaceId,
} from '../../../../support/attempts/http-node-attempt.js';

import type { ArtifactScenario } from './context.js';

export async function proveArtifactSlackRedelivery(scenario: ArtifactScenario) {
  const {
    accepted,
    coordinatorOutboxes,
    attemptQueue,
    producer,
    slackRequests,
    retained,
  } = scenario;
  const slackContinuation = await continuation(
    accepted.runId,
    coordinatorOutboxes,
  );
  coordinatorOutboxes.push(slackContinuation);
  await producer.publish({
    name: JOB_NAME.advanceWorkflowRun,
    data: {
      workspaceId,
      runId: accepted.runId,
      outboxEventId: slackContinuation,
    },
  });
  const slack = await attemptDelivery(accepted.runId, 'slack');
  const slackDelivery = {
    name: JOB_NAME.executeNodeAttempt,
    data: {
      workspaceId,
      runId: accepted.runId,
      nodeRunId: slack.node_run_id,
      attemptId: slack.attempt_id,
      outboxEventId: slack.outbox_id,
    },
  };
  const slackJob = await producer.publish(slackDelivery);
  const slackTerminal = await waitFor(
    () =>
      workerQuery<{
        attempt_status: string;
        dispatch_marked_at: Date | null;
        executor_error_kind: string | null;
        executor_failure_kind: string | null;
        error_summary: string | null;
        node_status: string;
        output_ref: unknown;
        safe_error_code: string | null;
      }>(
        `select attempt.status attempt_status,attempt.dispatch_marked_at,
                    attempt.executor_error_kind,attempt.executor_failure_kind,
                    attempt.error_summary,
                    attempt.safe_error_code,node.status node_status,attempt.output_ref
             from app.node_attempts attempt
             join app.node_runs node
               on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
             where attempt.workspace_id=$1 and attempt.id=$2`,
        [workspaceId, slack.attempt_id],
      ),
    (rows) => rows[0]?.attempt_status === 'succeeded',
  );
  expect(slackTerminal[0]).toMatchObject({
    attempt_status: 'succeeded',
    node_status: 'succeeded',
    output_ref: {
      kind: 'inline',
      value: {
        channelId: 'C123ABC',
        messageTs: '1724412345.000100',
      },
    },
  });
  expect(slackTerminal[0]?.dispatch_marked_at).toBeInstanceOf(Date);
  expect(slackRequests).toEqual([
    {
      botToken: slackBotToken,
      channelId: 'C123ABC',
      text: slackMessageText,
    },
  ]);
  const slackAudit = await withOwner((client) =>
    client.query<{ count: string }>(
      `select count(*)::text count from app.connection_events
           where workspace_id=$1 and connection_id=$2
             and event_type='connection.credential_accessed'
             and actor_kind='worker'`,
      [workspaceId, slackConnectionId],
    ),
  );
  expect(slackAudit.rows[0]?.count).toBe(
    String(retained.slackAuditBaseline + 1),
  );
  const completedSlackJob = await waitFor(
    () => attemptQueue.getJob(slackJob.jobId),
    (job) => job !== undefined,
  );
  if (completedSlackJob === undefined) throw new Error('Slack job missing');
  await waitFor(
    () => completedSlackJob.getState(),
    (state) => state === 'completed',
  );
  await completedSlackJob.remove();
  await producer.publish(slackDelivery);
  const replayedSlackJob = await waitFor(
    () => attemptQueue.getJob(slackJob.jobId),
    (job) => job !== undefined,
  );
  if (replayedSlackJob === undefined)
    throw new Error('redelivered Slack job missing');
  await waitFor(
    () => replayedSlackJob.getState(),
    (state) => state === 'completed',
  );
  expect(slackRequests).toHaveLength(1);

  return { slackDelivery, replayedSlackJob };
}
