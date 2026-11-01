import { createHash, randomUUID } from 'node:crypto';
import { JOB_NAME } from '@pertexo/queue';

import { expect, it } from 'vitest';

import { createHttpNodeAttemptProofRuntime } from '../../../support/attempts/http-node-attempt.runtime.js';

import {
  acceptRun,
  actorId,
  attemptDelivery,
  connectionStore,
  connectionId,
  continuation,
  slackConnectionId,
  waitFor,
  workerQuery,
  workspaceId,
} from '../../../support/attempts/http-node-attempt.js';

import {
  fixtureEncryption,
  publishAndWaitForCompletion,
  closeProofRuntime,
} from '../fixture.js';

export function registerDispatchSecretFences(): void {
  it.each(['http', 'slack'] as const)(
    'rejects a %s dispatch when its resolved secret rotates after the current-version assertion',
    async (target) => {
      const encryption = fixtureEncryption;
      if (encryption === undefined)
        throw new Error('HTTP attempt fixture encryption is missing');
      if (connectionStore === undefined)
        throw new Error('Connection database missing');
      const apiConnectionDatabase = connectionStore;

      const targetConnectionId =
        target === 'http' ? connectionId : slackConnectionId;
      const targetAuthType =
        target === 'http'
          ? ('http_headers' as const)
          : ('slack_bot_token' as const);
      let rotated = false;
      const runtime = await createHttpNodeAttemptProofRuntime(encryption, {
        afterConnectionAssertCurrent: async (input) => {
          if (rotated || input.connectionId !== targetConnectionId) return;
          expect(input.expectedAuthType).toBe(targetAuthType);
          rotated = true;
          const rotatedSecretVersionId = randomUUID();
          const rotatedSecret = new TextEncoder().encode(
            JSON.stringify(
              target === 'http'
                ? {
                    type: 'http_headers',
                    headers: { authorization: 'Bearer rotated-http' },
                  }
                : {
                    type: 'slack_bot_token',
                    botToken: 'xoxb-rotated-slack',
                  },
            ),
          );
          const sealed = await encryption.seal(rotatedSecret, {
            workspaceId,
            connectionId: targetConnectionId,
            secretVersionId: rotatedSecretVersionId,
          });
          rotatedSecret.fill(0);
          await apiConnectionDatabase.rotateConnectionSecret({
            workspaceId,
            actorId,
            connectionId: targetConnectionId,
            secretVersionId: rotatedSecretVersionId,
            expectedCurrentSecretVersionId: input.secretVersionId,
            expectedAuthType: targetAuthType,
            sealed,
            idempotencyKey: randomUUID(),
            requestHash: createHash('sha256')
              .update(randomUUID())
              .digest('hex'),
          });
        },
      });
      const {
        attemptQueue,
        attempts,
        coordinator,
        coordinatorQueue,
        producer,
        slackRequests,
        transportRequests,
      } = runtime;
      const accepted = await acceptRun();
      try {
        await Promise.all([
          coordinator.consumer.waitUntilReady(5_000),
          attempts.consumer.waitUntilReady(5_000),
          producer.waitUntilReady(5_000),
        ]);
        await publishAndWaitForCompletion(
          producer,
          coordinatorQueue,
          {
            name: JOB_NAME.advanceWorkflowRun,
            data: {
              workspaceId,
              runId: accepted.runId,
              outboxEventId: accepted.outboxEventId,
            },
          },
          'Initial coordinator',
        );

        const manual = await attemptDelivery(accepted.runId, 'manual');
        await publishAndWaitForCompletion(
          producer,
          attemptQueue,
          {
            name: JOB_NAME.executeNodeAttempt,
            data: {
              workspaceId,
              runId: accepted.runId,
              nodeRunId: manual.node_run_id,
              attemptId: manual.attempt_id,
              outboxEventId: manual.outbox_id,
            },
          },
          'Manual node attempt',
        );

        const firstContinuation = await continuation(accepted.runId, [
          accepted.outboxEventId,
        ]);
        await publishAndWaitForCompletion(
          producer,
          coordinatorQueue,
          {
            name: JOB_NAME.advanceWorkflowRun,
            data: {
              workspaceId,
              runId: accepted.runId,
              outboxEventId: firstContinuation,
            },
          },
          'HTTP admission',
        );

        const httpAttempt = await attemptDelivery(accepted.runId, 'http');
        await publishAndWaitForCompletion(
          producer,
          attemptQueue,
          {
            name: JOB_NAME.executeNodeAttempt,
            data: {
              workspaceId,
              runId: accepted.runId,
              nodeRunId: httpAttempt.node_run_id,
              attemptId: httpAttempt.attempt_id,
              outboxEventId: httpAttempt.outbox_id,
            },
          },
          'HTTP node attempt',
        );
        let targetAttempt = httpAttempt;
        const terminalContinuationExclusions = [
          accepted.outboxEventId,
          firstContinuation,
        ];
        if (target === 'slack') {
          await waitFor(
            () =>
              workerQuery<{ status: string }>(
                `select status from app.node_attempts
                 where workspace_id=$1 and id=$2`,
                [workspaceId, httpAttempt.attempt_id],
              ),
            (rows) => rows[0]?.status === 'succeeded',
          );
          const slackContinuation = await continuation(
            accepted.runId,
            terminalContinuationExclusions,
          );
          terminalContinuationExclusions.push(slackContinuation);
          await publishAndWaitForCompletion(
            producer,
            coordinatorQueue,
            {
              name: JOB_NAME.advanceWorkflowRun,
              data: {
                workspaceId,
                runId: accepted.runId,
                outboxEventId: slackContinuation,
              },
            },
            'Slack admission',
          );
          targetAttempt = await attemptDelivery(accepted.runId, 'slack');
          await publishAndWaitForCompletion(
            producer,
            attemptQueue,
            {
              name: JOB_NAME.executeNodeAttempt,
              data: {
                workspaceId,
                runId: accepted.runId,
                nodeRunId: targetAttempt.node_run_id,
                attemptId: targetAttempt.attempt_id,
                outboxEventId: targetAttempt.outbox_id,
              },
            },
            'Slack node attempt',
          );
        }
        const terminal = await waitFor(
          () =>
            workerQuery<{
              attempt_status: string;
              dispatch_marked_at: Date | null;
              executor_error_kind: string | null;
              executor_failure_kind: string | null;
              executor_possibly_dispatched: boolean | null;
              node_status: string;
            }>(
              `select attempt.status attempt_status,attempt.dispatch_marked_at,
                      attempt.executor_error_kind,attempt.executor_failure_kind,
                      attempt.executor_possibly_dispatched,node.status node_status
               from app.node_attempts attempt
               join app.node_runs node
                 on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id
               where attempt.workspace_id=$1 and attempt.id=$2`,
              [workspaceId, targetAttempt.attempt_id],
            ),
          (rows) => rows[0]?.attempt_status === 'failed',
        );
        expect(terminal[0]).toMatchObject({
          attempt_status: 'failed',
          dispatch_marked_at: null,
          executor_error_kind: 'authentication',
          executor_failure_kind: 'failed',
          executor_possibly_dispatched: false,
          node_status: 'running',
        });
        const terminalContinuation = await continuation(accepted.runId, [
          ...terminalContinuationExclusions,
        ]);
        await publishAndWaitForCompletion(
          producer,
          coordinatorQueue,
          {
            name: JOB_NAME.advanceWorkflowRun,
            data: {
              workspaceId,
              runId: accepted.runId,
              outboxEventId: terminalContinuation,
            },
          },
          'Terminal coordinator',
        );
        const finalized = await waitFor(
          () =>
            workerQuery<{
              attempt_count: string;
              node_status: string;
              retry_decision: string | null;
              run_status: string;
            }>(
              `select attempt.retry_decision,node.status node_status,
                      run.status run_status,
                      (select count(*)::text from app.node_attempts counted
                        where counted.workspace_id=node.workspace_id
                          and counted.node_run_id=node.id) attempt_count
                 from app.node_attempts attempt
                 join app.node_runs node
                   on node.workspace_id=attempt.workspace_id
                  and node.id=attempt.node_run_id
                 join app.workflow_runs run
                   on run.workspace_id=node.workspace_id
                  and run.id=node.workflow_run_id
                where attempt.workspace_id=$1 and attempt.id=$2`,
              [workspaceId, targetAttempt.attempt_id],
            ),
          (rows) => rows[0]?.run_status === 'failed',
        );
        expect(finalized).toEqual([
          {
            attempt_count: '1',
            node_status: 'failed',
            retry_decision: 'failed',
            run_status: 'failed',
          },
        ]);
        expect(rotated).toBe(true);
        expect(transportRequests).toHaveLength(target === 'http' ? 0 : 1);
        expect(slackRequests).toHaveLength(0);
      } finally {
        await closeProofRuntime(runtime);
      }
    },
    30_000,
  );
}
