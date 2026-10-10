import { describe, expect, it } from 'vitest';

import {
  asRuntime,
  checkpoint,
  insertRun,
  rawStore,
  testDelivery,
  versionA,
  workerBaseUrl,
  workspaceA,
} from './fixtures.js';

describe('Coordinator resumed run status', () => {
  it('persists running with a newly admitted attempt after a waiting checkpoint', async () => {
    const current = checkpoint({ runStatus: 'waiting' });
    const runId = await insertRun({
      schedulerState: current,
      status: 'waiting',
    });
    const invocationKey = `${versionA}|resumed-node|b:|i:`;
    const next = {
      ...current,
      revision: 1,
      runStatus: 'running',
      nextEventSequence: 3,
      admittedInvocationKeys: [invocationKey],
      invocations: [
        {
          invocationKey,
          nodeId: 'resumed-node',
          status: 'running',
          attemptNumber: 1,
        },
      ],
    } as const;
    const plan = {
      expectedRevision: 0,
      expectedNextEventSequence: 2,
      consumedThroughEventSequence: 1,
      checkpoint: next,
      events: [
        {
          schemaVersion: 1,
          sequence: 2,
          name: 'node.ready',
          occurredAt: '2026-09-27T12:00:00.000Z',
          invocationKey,
          nodeId: 'resumed-node',
          attemptNumber: 0,
        },
      ],
      nodeRunAdmissions: [
        { invocationKey, nodeId: 'resumed-node', sideEffectClass: 'safe' },
      ],
      attempts: [
        {
          invocationKey,
          nodeId: 'resumed-node',
          attemptNumber: 1,
          sideEffectClass: 'safe',
        },
      ],
    } as const;
    const delivery = await testDelivery(workspaceA, runId, 0);
    await expect(
      rawStore.commitAdvancePlan({
        workspaceId: workspaceA,
        runId,
        workflowVersionId: versionA,
        delivery,
        plan,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ kind: 'committed', revision: 1 });
    const rows = await asRuntime(workerBaseUrl, workspaceA, (client) =>
      client.query<{
        run_status: string;
        checkpoint_status: string;
        attempt_status: string;
      }>(
        `select run.status run_status,
                checkpoint.scheduler_state->>'runStatus' checkpoint_status,
                attempt.status attempt_status
         from app.workflow_runs run
         join app.run_checkpoints checkpoint
           on checkpoint.workspace_id=run.workspace_id
          and checkpoint.workflow_run_id=run.id
         join app.node_runs node
           on node.workspace_id=run.workspace_id
          and node.workflow_run_id=run.id
         join app.node_attempts attempt
           on attempt.workspace_id=node.workspace_id
          and attempt.node_run_id=node.id
         where run.workspace_id=$1 and run.id=$2`,
        [workspaceA, runId],
      ),
    );
    expect(rows.rows).toEqual([
      {
        run_status: 'running',
        checkpoint_status: 'running',
        attempt_status: 'ready',
      },
    ]);
  });
});
