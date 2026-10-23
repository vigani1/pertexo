import { it, expect } from 'vitest';

import {
  apiBaseUrl,
  asRuntime,
  checkpoint,
  insertRun,
  notificationDestinationId,
  notificationSecretVersionId,
  rawStore,
  testDelivery,
  versionA,
  workerBaseUrl,
  workspaceA,
} from '../../fixtures.js';

export function registerExcludesPolicyPinnedCanceledTransition(): void {
  it('excludes a policy-pinned canceled transition from notification intent creation', async () => {
    const canceledRun = await insertRun({
      status: 'running',
      schedulerState: checkpoint({ runStatus: 'running' }),
      failureNotificationPolicy: {
        destinationId: notificationDestinationId,
        destinationConfigVersion: 1,
        sideEffectClass: 'idempotent_with_key',
        connectionSecretVersionId: notificationSecretVersionId,
      },
    });
    await asRuntime(apiBaseUrl, workspaceA, async (client) => {
      await client.query(
        `update app.workflow_runs
         set cancel_requested_at=clock_timestamp(),cancel_requested_by='q12-test'
         where workspace_id=$1 and id=$2`,
        [workspaceA, canceledRun],
      );
      await client.query(
        `insert into app.run_events (
           workspace_id,workflow_run_id,sequence,type,payload
         ) values ($1,$2,2,'run.cancel_requested','{}')`,
        [workspaceA, canceledRun],
      );
    });
    const delivery = await testDelivery(workspaceA, canceledRun, 0);
    await expect(
      rawStore.commitAdvancePlan({
        workspaceId: workspaceA,
        runId: canceledRun,
        workflowVersionId: versionA,
        signal: new AbortController().signal,
        delivery,
        plan: {
          expectedRevision: 0,
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 2,
          checkpoint: checkpoint({
            revision: 1,
            runStatus: 'canceled',
            nextEventSequence: 4,
            cancelRequested: true,
          }),
          events: [
            {
              sequence: 3,
              name: 'run.canceled',
              occurredAt: '2026-09-13T00:00:00.000Z',
            },
          ],
          nodeRunAdmissions: [],
          attempts: [],
        },
      }),
    ).resolves.toMatchObject({ kind: 'committed', revision: 1 });
    const excluded = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{ intent_count: number; notification_outbox_count: number }>(
        `select count(distinct intent.id)::int intent_count,
                count(distinct outbox.id)::int notification_outbox_count
         from app.workflow_runs run
         left join app.run_failure_notification_intents intent
           on intent.workspace_id=run.workspace_id
          and intent.workflow_run_id=run.id
         left join app.outbox_events outbox on outbox.aggregate_id=intent.id
         where run.workspace_id=$1 and run.id=$2`,
        [workspaceA, canceledRun],
      ),
    );
    expect(excluded.rows).toEqual([
      { intent_count: 0, notification_outbox_count: 0 },
    ]);
  });
}
