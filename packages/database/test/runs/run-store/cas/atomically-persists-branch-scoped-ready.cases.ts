import { it, expect } from 'vitest';
import {
  asRuntime,
  checkpoint,
  insertRun,
  nodeAttemptStore,
  ownedDeliveryStore,
  versionA,
  workerBaseUrl,
  workspaceA,
} from '../fixtures.js';

export function registerAtomicallyPersistsBranchScopedReady(): void {
  it('atomically persists branch-scoped ready and skipped node runs', async () => {
    const selectedKey = `${versionA}|selected|b:condition%3Atrue|i:`;
    const skippedKey = `${versionA}|skipped|b:condition%3Afalse|i:`;
    const initial = {
      ...checkpoint({}),
      branchSelections: [],
    } as const;
    const runId = await insertRun({ schedulerState: initial });

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
          checkpoint: {
            ...initial,
            revision: 1,
            runStatus: 'running',
            nextEventSequence: 5,
            admittedInvocationKeys: [selectedKey],
            invocations: [
              {
                invocationKey: selectedKey,
                nodeId: 'selected',
                status: 'running',
                attemptNumber: 1,
                branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
              },
              {
                invocationKey: skippedKey,
                nodeId: 'skipped',
                status: 'skipped',
                attemptNumber: 0,
                branchPath: [{ nodeId: 'condition', outputPort: 'false' }],
              },
            ],
          },
          events: [
            {
              sequence: 2,
              name: 'run.started',
              occurredAt: '2026-08-24T00:00:00.000Z',
            },
            {
              sequence: 3,
              name: 'node.ready',
              occurredAt: '2026-08-24T00:00:00.000Z',
              invocationKey: selectedKey,
              nodeId: 'selected',
              attemptNumber: 0,
            },
            {
              sequence: 4,
              name: 'node.skipped',
              occurredAt: '2026-08-24T00:00:00.000Z',
              invocationKey: skippedKey,
              nodeId: 'skipped',
              attemptNumber: 0,
            },
          ],
          nodeRunAdmissions: [
            {
              invocationKey: selectedKey,
              nodeId: 'selected',
              sideEffectClass: 'safe',
              branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
            },
            {
              invocationKey: skippedKey,
              nodeId: 'skipped',
              sideEffectClass: 'safe',
              branchPath: [{ nodeId: 'condition', outputPort: 'false' }],
            },
          ],
          attempts: [
            {
              invocationKey: selectedKey,
              nodeId: 'selected',
              attemptNumber: 1,
              sideEffectClass: 'safe',
              branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
            },
          ],
        },
      }),
    ).resolves.toMatchObject({ kind: 'committed' });

    const persisted = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        invocation_key: string;
        branch_context: unknown;
        status: string;
        attempts: number;
        deliveries: number;
      }>(
        `select node.invocation_key,node.branch_context,node.status,
                    count(distinct attempt.id)::int attempts,
                    count(distinct event.id)::int deliveries
               from app.node_runs node
               left join app.node_attempts attempt on attempt.node_run_id=node.id
               left join app.outbox_events event
                 on event.aggregate_id=attempt.id
                and event.job_name='execute-node-attempt'
              where node.workspace_id=$1 and node.workflow_run_id=$2
              group by node.id
              order by node.invocation_key`,
        [workspaceA, runId],
      ),
    );
    expect(persisted.rows).toEqual([
      {
        invocation_key: selectedKey,
        branch_context: {
          branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
        },
        status: 'ready',
        attempts: 1,
        deliveries: 1,
      },
      {
        invocation_key: skippedKey,
        branch_context: {
          branchPath: [{ nodeId: 'condition', outputPort: 'false' }],
        },
        status: 'skipped',
        attempts: 0,
        deliveries: 0,
      },
    ]);
    const selectedAttempt = await asRuntime(
      workerBaseUrl,
      workspaceA,
      (client) =>
        client.query<{
          attempt_id: string;
          node_run_id: string;
          outbox_id: string;
          payload_checksum: string;
        }>(
          `select attempt.id attempt_id,node.id node_run_id,
                    event.id outbox_id,event.payload_checksum
               from app.node_runs node
               join app.node_attempts attempt on attempt.node_run_id=node.id
               join app.outbox_events event on event.aggregate_id=attempt.id
              where node.workspace_id=$1 and node.workflow_run_id=$2
                and node.invocation_key=$3
                and event.job_name='execute-node-attempt'`,
          [workspaceA, runId, selectedKey],
        ),
    );
    const selectedDelivery = selectedAttempt.rows[0];
    if (selectedDelivery === undefined)
      throw new Error('branch-scoped fixture attempt missing');
    await expect(
      nodeAttemptStore.claimDelivery({
        workspaceId: workspaceA,
        runId,
        nodeRunId: selectedDelivery.node_run_id,
        attemptId: selectedDelivery.attempt_id,
        delivery: {
          outboxEventId: selectedDelivery.outbox_id,
          payloadChecksum: selectedDelivery.payload_checksum,
        },
        leaseDurationSeconds: 30,
        workerId: 'attempt-worker-branch',
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      kind: 'claimed',
      lease: {
        invocationKey: selectedKey,
        branchPath: [{ nodeId: 'condition', outputPort: 'true' }],
      },
    });
    await expect(
      ownedDeliveryStore.loadAdvanceState({
        workspaceId: workspaceA,
        runId,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'ready' });
  });
}
