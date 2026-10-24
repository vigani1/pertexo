import { JOB_NAME } from '@pertexo/queue';

import { expect } from 'vitest';
import { waitForCoordinatorOutbox } from '../../../../support/coordinator/runs.js';
import { waitFor, workerQuery, workspaceId } from '../fixture.js';
import type {
  AcceptedForEachScenario,
  ForEachScenarioContext,
} from './contract.js';

export function createForEachDelivery(
  context: Pick<
    ForEachScenarioContext,
    'ownedProducer' | 'ownedCoordinatorQueue' | 'ownedAttemptQueue'
  > &
    Readonly<{ accepted: AcceptedForEachScenario }>,
) {
  const { accepted, ownedProducer, ownedCoordinatorQueue, ownedAttemptQueue } =
    context;
  const coordinatorOutboxes = [accepted.outboxEventId];
  const attemptOutboxes: string[] = [];
  const publishCoordinator = async (
    outboxEventId: string,
    expectedRevision: number,
  ) => {
    const published = await ownedProducer.publish({
      name: JOB_NAME.advanceWorkflowRun,
      data: {
        workspaceId,
        runId: accepted.runId,
        outboxEventId,
      },
    });
    const result = await waitFor(
      async () => {
        const [rows, job] = await Promise.all([
          workerQuery<{ revision: number }>(
            `select revision from app.run_checkpoints
                   where workspace_id=$1 and workflow_run_id=$2`,
            [workspaceId, accepted.runId],
          ),
          ownedCoordinatorQueue.getJob(published.jobId),
        ]);
        return {
          failedReason: job?.failedReason,
          stacktrace: job?.stacktrace,
          revision: rows[0]?.revision,
          state: await job?.getState(),
        };
      },
      ({ revision, state }) =>
        state === 'failed' ||
        (revision === expectedRevision &&
          (state === undefined || state === 'completed')),
    );
    if (result.state === 'failed' || result.revision !== expectedRevision)
      throw new Error(
        `For Each coordinator failed: ${result.failedReason ?? 'unknown'} ${JSON.stringify(result.stacktrace)}`,
      );
  };
  const continueAfter = async (expectedRevision: number) => {
    const outbox = await waitForCoordinatorOutbox(
      accepted.runId,
      coordinatorOutboxes,
    );
    coordinatorOutboxes.push(outbox);
    await publishCoordinator(outbox, expectedRevision);
    return outbox;
  };
  const findAttempt = async (nodeId: string, ordinal?: number) => {
    const rows = await waitFor(
      () =>
        workerQuery<{
          attempt_id: string;
          node_run_id: string;
          outbox_id: string;
          payload_checksum: string;
        }>(
          `select attempt.id attempt_id,node.id node_run_id,outbox.id outbox_id,
                        outbox.payload_checksum
                   from app.outbox_events outbox
                   join app.node_attempts attempt on attempt.id=outbox.aggregate_id
                   join app.node_runs node on node.id=attempt.node_run_id
                  where node.workspace_id=$1 and node.workflow_run_id=$2
                    and node.node_id=$3 and outbox.job_name='execute-node-attempt'
                    and not (outbox.id=any($4::uuid[]))
                    and ($5::int is null or
                      (node.branch_context->'iterationPath'->0->>'ordinal')::int=$5)
                  order by outbox.created_at,outbox.id`,
          [
            workspaceId,
            accepted.runId,
            nodeId,
            attemptOutboxes,
            ordinal ?? null,
          ],
        ),
      (value) => value.length === 1,
    );
    const attempt = rows[0];
    if (attempt === undefined) throw new Error('For Each attempt missing');
    attemptOutboxes.push(attempt.outbox_id);
    return attempt;
  };
  const execute = async (nodeId: string, ordinal?: number) => {
    const attempt = await findAttempt(nodeId, ordinal);
    const published = await ownedProducer.publish({
      name: JOB_NAME.executeNodeAttempt,
      data: {
        workspaceId,
        runId: accepted.runId,
        nodeRunId: attempt.node_run_id,
        attemptId: attempt.attempt_id,
        outboxEventId: attempt.outbox_id,
      },
    });
    const result = await waitFor(
      async () => {
        const [nodeRows, job] = await Promise.all([
          workerQuery<{ status: string }>(
            `select status from app.node_runs where workspace_id=$1 and id=$2`,
            [workspaceId, attempt.node_run_id],
          ),
          ownedAttemptQueue.getJob(published.jobId),
        ]);
        return {
          failedReason: job?.failedReason,
          state: await job?.getState(),
          status: nodeRows[0]?.status,
        };
      },
      ({ state, status }) =>
        state === 'failed' ||
        (status === 'succeeded' &&
          (state === undefined || state === 'completed')),
    );
    if (result.state === 'failed' || result.status !== 'succeeded')
      throw new Error(
        `For Each attempt failed: ${result.failedReason ?? 'unknown'}`,
      );
    return attempt;
  };
  const executeDuplicateAttempt = async (attempt: {
    attempt_id: string;
    node_run_id: string;
    outbox_id: string;
  }) => {
    const published = await ownedProducer.publish({
      name: JOB_NAME.executeNodeAttempt,
      data: {
        workspaceId,
        runId: accepted.runId,
        nodeRunId: attempt.node_run_id,
        attemptId: attempt.attempt_id,
        outboxEventId: attempt.outbox_id,
      },
    });
    const job = await waitFor(
      () => ownedAttemptQueue.getJob(published.jobId),
      (value) => value !== undefined,
    );
    if (job === undefined) throw new Error('duplicate attempt disappeared');
    await waitFor(
      () => job.getState(),
      (state) => state === 'completed' || state === 'failed',
    );
    await expect(job.getState()).resolves.toBe('completed');
  };

  return {
    coordinatorOutboxes,
    publishCoordinator,
    continueAfter,
    findAttempt,
    execute,
    executeDuplicateAttempt,
  };
}
