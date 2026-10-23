import { it, expect } from 'vitest';
import {
  CoordinatorRunStateCorruptError,
  asRuntime,
  checkpoint,
  insertRun,
  ownedDeliveryStore,
  versionA,
  workerBaseUrl,
  workspaceA,
} from '../fixtures.js';

export function registerRollsBackAllWritesLate(): void {
  it('rolls back all writes when a late physical event membership check fails', async () => {
    const admitted = 'version-a/admitted';
    const ghost = 'version-a/ghost';
    const runId = await insertRun({
      schedulerState: checkpoint({
        readySet: [ghost],
        invocations: [
          {
            invocationKey: ghost,
            nodeId: 'ghost',
            status: 'ready',
            attemptNumber: 0,
          },
        ],
      }),
    });
    await expect(
      ownedDeliveryStore.commitAdvancePlan({
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
            runStatus: 'running',
            nextEventSequence: 5,
            readySet: [],
            admittedInvocationKeys: [admitted],
            invocations: [
              {
                invocationKey: admitted,
                nodeId: 'admitted',
                status: 'running',
                attemptNumber: 1,
              },
              {
                invocationKey: ghost,
                nodeId: 'ghost',
                status: 'failed',
                attemptNumber: 0,
              },
            ],
          }),
          events: [
            {
              sequence: 2,
              name: 'run.started',
              occurredAt: '2026-08-21T00:00:00.000Z',
            },
            {
              sequence: 3,
              name: 'node.ready',
              occurredAt: '2026-08-21T00:00:00.000Z',
              invocationKey: admitted,
              nodeId: 'admitted',
              attemptNumber: 0,
            },
            {
              sequence: 4,
              name: 'node.failed',
              occurredAt: '2026-08-21T00:00:00.000Z',
              invocationKey: ghost,
              nodeId: 'ghost',
              attemptNumber: 0,
            },
          ],
          nodeRunAdmissions: [
            {
              invocationKey: admitted,
              nodeId: 'admitted',
              sideEffectClass: 'safe',
            },
          ],
          attempts: [
            {
              invocationKey: admitted,
              nodeId: 'admitted',
              attemptNumber: 1,
              sideEffectClass: 'safe',
            },
          ],
        },
      }),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);
    const counts = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        nodes: number;
        attempts: number;
        events: number;
        inbox: number;
        revision: number;
      }>(
        `select
             (select count(*)::int from app.node_runs where workflow_run_id=$1) nodes,
             (select count(*)::int from app.node_attempts attempt join app.node_runs node on node.id=attempt.node_run_id where node.workflow_run_id=$1) attempts,
             (select count(*)::int from app.run_events where workflow_run_id=$1) events,
             (select count(*)::int from app.inbox_receipts receipt
               join app.outbox_events event on event.id=receipt.message_id
               where event.aggregate_id=$1) inbox,
             (select revision from app.run_checkpoints where workflow_run_id=$1) revision`,
        [runId],
      ),
    );
    expect(counts.rows[0]).toEqual({
      nodes: 0,
      attempts: 0,
      events: 1,
      inbox: 0,
      revision: 0,
    });
  });
}
