import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';

import { readWorkflowRunReadRecord } from '../../../../src/runs/commands/records.repository.js';
import { apiDatabase, workspaceA } from '../../../runs/acceptance/fixtures.js';
import {
  acceptRun,
  claimRuns,
  publishClaims,
  setLimit,
  transitionRun,
} from '../concurrency-admission.fixtures.js';

export function registerExplainsWorkspaceCapacityBlockers(): void {
  it('explains a queued run held only by the shared workspace limit', async () => {
    const runs = [];
    for (let index = 0; index < 6; index += 1) {
      const workflowId = randomUUID();
      await setLimit(1, workflowId);
      runs.push(
        await acceptRun({ workflowId, workflowVersionId: randomUUID() }),
      );
    }
    const claimed = new Set<string>();
    for (;;) {
      const batch = await claimRuns();
      if (batch.events.length === 0) break;
      for (const event of batch.events) claimed.add(event.aggregateId);
      await publishClaims(batch);
    }
    const waiting = runs.find(({ runId }) => !claimed.has(runId));
    const reserved = runs.find(({ runId }) => claimed.has(runId));
    if (waiting === undefined || reserved === undefined)
      throw new Error('The workspace limit should hold back exactly one run');
    const blockers = (runId: string) =>
      apiDatabase.withWorkspace(
        workspaceA,
        async (transaction) =>
          (
            await readWorkflowRunReadRecord(transaction, runId, {
              includeWorkflowName: false,
            })
          )?.admissionBlockers ?? null,
      );

    expect(await blockers(waiting.runId)).toMatchObject({
      reasons: ['workspace_capacity'],
    });
    expect(await blockers(reserved.runId)).toMatchObject({ reasons: [] });

    await transitionRun(reserved.runId, 'succeeded');
    expect(await blockers(waiting.runId)).toMatchObject({ reasons: [] });
  });
}
