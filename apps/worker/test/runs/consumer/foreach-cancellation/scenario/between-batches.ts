import { parseCheckpoint } from '@pertexo/workflow-engine';

import { expect } from 'vitest';
import { cancelFixtureRun } from '../../../../support/coordinator/runs.js';
import { waitFor, workerQuery, workspaceId } from '../fixture.js';
import type { ForEachPhaseContext } from './contract.js';

export async function assertBetweenBatchCancellation(
  context: ForEachPhaseContext,
) {
  const { accepted, eraseRedisAndRestart } = context;
  const { continueAfter } = context.delivery;

  await cancelFixtureRun(accepted.runId, 'cancel between canonical batches');
  await eraseRedisAndRestart();
  await continueAfter(6);
  const canceled = await waitFor(
    () =>
      workerQuery<{ scheduler_state: unknown; status: string }>(
        `select run.status,checkpoint.scheduler_state
                   from app.workflow_runs run
                   join app.run_checkpoints checkpoint
                     on checkpoint.workflow_run_id=run.id
                  where run.workspace_id=$1 and run.id=$2`,
        [workspaceId, accepted.runId],
      ),
    (rows) => rows[0]?.status === 'canceled',
  );
  expect(parseCheckpoint(canceled[0]?.scheduler_state)).toMatchObject({
    cancelRequested: true,
    remainingIterationBudget: 997,
    runStatus: 'canceled',
  });
  await expect(
    workerQuery<{ count: string }>(
      `select count(*)::text count from app.node_runs
                where workspace_id=$1 and workflow_run_id=$2
                  and branch_context->'iterationPath' @> '[{"loopNodeId":"for-each","ordinal":2}]'::jsonb`,
      [workspaceId, accepted.runId],
    ),
  ).resolves.toEqual([{ count: '0' }]);
  return;
}
