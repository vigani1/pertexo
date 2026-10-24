import { acceptWorkflowRun } from '../../../../src/runs/commands/acceptance.repository.js';
import { withWorkspaceTransaction } from '../../../../src/tenant-access/transactions.js';

import { expect, it } from 'vitest';
import { createCheckpoint } from '@pertexo/workflow-engine';

import { admin } from '../../../lifecycle/calls/fixtures.js';

import { pool, fixture } from './fixture.js';

export function registerRetainsErrorWorkflowOriginOn(): void {
  it('retains error-workflow origin on deliberate replay admission', async () => {
    const f = await fixture('failed', true);
    const accepted = await withWorkspaceTransaction(
      pool,
      f.workspaceId,
      (transaction) =>
        acceptWorkflowRun(transaction, {
          initialCheckpoint: createCheckpoint({
            workflowVersionId: f.childVersionId,
            iterationBudget: 200,
            nextEventSequence: 2,
          }),
          operation: 'workflow.run.accept',
          scope: `workflow-error-replay:${f.parentRunId}`,
          keyHash: 'd'.repeat(64),
          requestHash: 'e'.repeat(64),
          workflowId: f.childWorkflowId,
          workflowVersionId: f.childVersionId,
          triggerType: 'replay',
          replaySourceRunId: f.parentRunId,
          replayCommandId: crypto.randomUUID(),
          runInput: {},
        }),
    );
    const row = await admin.query<{ error_workflow_origin: boolean }>(
      'select error_workflow_origin from app.workflow_runs where id=$1',
      [accepted.runId],
    );
    expect(row.rows[0]?.error_workflow_origin).toBe(true);
  });
}
