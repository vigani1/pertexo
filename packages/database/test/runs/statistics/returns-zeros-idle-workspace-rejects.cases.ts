import { expect, it } from 'vitest';

import {
  runs,
  person,
  busyWorkspace,
  addWorkflows,
  addRuns,
  zero,
} from './fixture.js';

export function registerReturnsZerosIdleWorkspaceRejects(): void {
  it('returns zeros for an idle workspace', async () => {
    await expect(
      runs.statistics({
        actorId: person,
        workspaceId: busyWorkspace,
        window: '24h',
        includeWorkflows: true,
      }),
    ).resolves.toMatchObject({
      current: { queued: 0, running: 0, waiting: 0 },
      window: { total: 0, byStatus: zero },
      workflows: { items: [], truncated: false },
    });
  });

  it('keeps the 50 busiest workflows, then the lowest identifiers, and says when it cut', async () => {
    const many = Array.from(
      { length: 52 },
      (_, index) =>
        [
          `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          `Workflow ${String(index)}`,
        ] as const,
    );
    await addWorkflows(busyWorkspace, many);
    for (const [id] of many)
      await addRuns(busyWorkspace, id, {
        status: 'succeeded',
        count: 1,
        age: '5 minutes',
      });
    const busiest = many[51]?.[0] ?? '';
    await addRuns(busyWorkspace, busiest, {
      status: 'failed',
      count: 2,
      age: '5 minutes',
    });

    const statistics = await runs.statistics({
      actorId: person,
      workspaceId: busyWorkspace,
      window: '1h',
      includeWorkflows: true,
    });

    expect(statistics.window.total).toBe(54);
    expect(statistics.workflows?.truncated).toBe(true);
    expect(statistics.workflows?.items).toHaveLength(50);
    expect(statistics.workflows?.items[0]).toMatchObject({
      workflowId: busiest,
      total: 3,
      byStatus: { ...zero, succeeded: 1, failed: 2 },
    });
    expect(
      statistics.workflows?.items.slice(1).map(({ workflowId }) => workflowId),
    ).toEqual(many.slice(0, 49).map(([id]) => id));
  });
}
