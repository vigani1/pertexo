import { expect, it } from 'vitest';

import { acceptWorkflowRun } from '../../../../src/runs/commands/acceptance.repository.js';

import {
  acceptanceInput,
  apiDatabase,
  expectAcceptanceRecordCounts,
  workspaceA,
} from '../fixtures.js';

export function registerSerializesConcurrentExactRetriesOne(): void {
  it('serializes concurrent exact retries to one accepted run', async () => {
    const [left, right] = await Promise.all([
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput()),
      ),
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput()),
      ),
    ]);

    expect(left.runId).toBe(right.runId);
    expect([left.duplicate, right.duplicate].sort()).toEqual([false, true]);
    await expectAcceptanceRecordCounts(1);
  });
}
