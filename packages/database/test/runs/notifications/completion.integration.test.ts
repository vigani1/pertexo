import { describe, expect, it } from 'vitest';
import {
  asRuntime,
  checkpoint,
  FailureNotificationContextSchema,
  insertRun,
  notificationDestinationId,
  notificationSecretVersionId,
  ownedDeliveryStore,
  versionA,
  workerBaseUrl,
  workspaceA,
} from '../run-store/fixtures.js';

describe('callable result failure notifications', () => {
  it('persists one run-level failure notification and outbox without inventing a failed step', async () => {
    const runId = await insertRun({
      failureNotificationPolicy: {
        destinationId: notificationDestinationId,
        destinationConfigVersion: 1,
        sideEffectClass: 'idempotent_with_key',
        connectionSecretVersionId: notificationSecretVersionId,
      },
    });
    const input = {
      workspaceId: workspaceA,
      runId,
      workflowVersionId: versionA,
      signal: new AbortController().signal,
      plan: {
        expectedRevision: 0,
        expectedNextEventSequence: 2,
        consumedThroughEventSequence: 1,
        checkpoint: checkpoint({
          revision: 1,
          runStatus: 'failed',
          nextEventSequence: 3,
          invocations: [],
        }),
        events: [
          {
            sequence: 2,
            name: 'run.failed' as const,
            occurredAt: '2026-08-24T10:01:00.000Z',
            reasonCode: 'callable_result_invalid',
          },
        ],
        nodeRunAdmissions: [],
        attempts: [],
      },
    };
    await expect(
      ownedDeliveryStore.commitAdvancePlan(input),
    ).resolves.toMatchObject({ kind: 'committed' });
    await expect(
      ownedDeliveryStore.commitAdvancePlan(input),
    ).resolves.toMatchObject({ kind: 'already_committed' });
    const proof = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{ context: unknown; outbox_count: number }>(
        `select intent.context,
         (select count(*)::int from app.outbox_events outbox where outbox.workspace_id=intent.workspace_id and outbox.aggregate_id=intent.id) outbox_count
       from app.run_failure_notification_intents intent
       where intent.workspace_id=$1 and intent.workflow_run_id=$2`,
        [workspaceA, runId],
      ),
    );
    expect(proof.rows).toHaveLength(1);
    expect(proof.rows[0]?.outbox_count).toBe(1);
    expect(
      FailureNotificationContextSchema.parse(proof.rows[0]?.context),
    ).toMatchObject({
      terminalStatus: 'failed',
      primaryFailure: {
        source: 'run',
        runStatus: 'failed',
        safeErrorCode: 'callable_result_invalid',
      },
      totalFailureCount: 1,
    });
  });
});
