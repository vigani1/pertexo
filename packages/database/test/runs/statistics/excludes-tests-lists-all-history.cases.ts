import { expect, it } from 'vitest';

import {
  runs,
  person,
  busyWorkspace,
  quietWorkspace,
  intake,
  sync,
  elsewhere,
  inWorkspace,
  addRuns,
  zero,
} from './fixture.js';

export function registerExcludesTestsListsAllHistory(): void {
  it('excludes tests from lists and all history statistics while counting their capacity', async () => {
    await addRuns(busyWorkspace, intake, {
      status: 'queued',
      count: 1,
      age: '1 hour',
    });
    await addRuns(busyWorkspace, intake, {
      status: 'succeeded',
      count: 1,
      age: '1 hour',
    });
    for (const status of [
      'queued',
      'running',
      'waiting',
      'succeeded',
      'failed',
      'canceled',
      'timed_out',
      'outcome_unknown',
    ])
      await addRuns(busyWorkspace, sync, {
        status: status,
        count: 1,
        age: '5 minutes',
      });
    await inWorkspace('owner', busyWorkspace, {
      text: `update app.workflow_runs set trigger_type='test' where workspace_id=$1 and workflow_id=$2`,
      values: [busyWorkspace, sync],
    });

    const page = await runs.list({
      actorId: person,
      workspaceId: busyWorkspace,
      limit: 100,
      includeWorkflowName: true,
    });
    expect(page.items).toHaveLength(2);
    expect(
      page.items.every(
        (run) => run.workflowId === intake && run.triggerType === 'api',
      ),
    ).toBe(true);
    expect(
      (
        await runs.list({
          actorId: person,
          workspaceId: busyWorkspace,
          workflowId: sync,
          limit: 100,
        })
      ).items,
    ).toEqual([]);
    const firstPage = await runs.list({
      actorId: person,
      workspaceId: busyWorkspace,
      limit: 1,
    });
    expect(firstPage.items[0]?.workflowId).toBe(intake);
    expect(firstPage.nextCursor).toBeDefined();
    const statistics = await runs.statistics({
      actorId: person,
      workspaceId: busyWorkspace,
      window: '24h',
      includeWorkflows: true,
      includeWorkflowName: true,
    });
    expect(statistics.current).toEqual({ queued: 1, running: 0, waiting: 0 });
    expect(statistics.window.total).toBe(2);
    expect(statistics.window.byStatus).toEqual({
      queued: 1,
      running: 0,
      waiting: 0,
      succeeded: 1,
      failed: 0,
      canceled: 0,
      timed_out: 0,
      outcome_unknown: 0,
    });
    expect(statistics.workflows?.items).toHaveLength(1);
    expect(statistics.workflows?.items[0]).toMatchObject({
      workflowId: intake,
      total: 2,
      byStatus: statistics.window.byStatus,
    });
    expect(
      (await runs.usageCapacity({ workspaceId: busyWorkspace })).execution,
    ).toMatchObject({ activeRuns: 2, queuedRuns: 2 });
  });

  it('counts current, windowed and per-workflow runs exactly in one snapshot', async () => {
    await addRuns(busyWorkspace, intake, {
      status: 'succeeded',
      count: 3,
      age: '10 minutes',
    });
    await addRuns(busyWorkspace, intake, {
      status: 'failed',
      count: 1,
      age: '10 minutes',
    });
    await addRuns(busyWorkspace, intake, {
      status: 'failed',
      count: 2,
      age: '3 hours',
    });
    await addRuns(busyWorkspace, intake, {
      status: 'timed_out',
      count: 1,
      age: '3 hours',
    });
    await addRuns(busyWorkspace, intake, {
      status: 'succeeded',
      count: 2,
      age: '12 hours',
    });
    await addRuns(busyWorkspace, intake, {
      status: 'outcome_unknown',
      count: 1,
      age: '12 hours',
    });
    await addRuns(busyWorkspace, intake, {
      status: 'canceled',
      count: 1,
      age: '12 hours',
    });
    await addRuns(busyWorkspace, intake, {
      status: 'succeeded',
      count: 4,
      age: '3 days',
    });
    await addRuns(busyWorkspace, intake, {
      status: 'succeeded',
      count: 5,
      age: '10 days',
    });
    await addRuns(busyWorkspace, sync, {
      status: 'running',
      count: 2,
      age: '20 minutes',
    });
    await addRuns(busyWorkspace, sync, {
      status: 'queued',
      count: 3,
      age: '20 minutes',
    });
    await addRuns(busyWorkspace, sync, {
      status: 'waiting',
      count: 1,
      age: '2 days',
    });
    await addRuns(quietWorkspace, elsewhere, {
      status: 'succeeded',
      count: 7,
      age: '10 minutes',
    });
    await addRuns(quietWorkspace, elsewhere, {
      status: 'running',
      count: 1,
      age: '10 minutes',
    });

    const hour = await runs.statistics({
      actorId: person,
      workspaceId: busyWorkspace,
      window: '1h',
    });
    expect(hour.current).toEqual({ queued: 3, running: 2, waiting: 1 });
    expect(hour.window).toMatchObject({
      duration: '1h',
      createdAtBefore: hour.asOf,
      total: 9,
      byStatus: { ...zero, succeeded: 3, failed: 1, running: 2, queued: 3 },
    });
    expect(hour).not.toHaveProperty('workflows');
    expect(hour.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u);
    expect(
      Date.parse(hour.window.createdAtBefore) -
        Date.parse(hour.window.createdAtFrom),
    ).toBe(3_600_000);
    expect(hour.window.createdAtFrom.slice(-8)).toBe(hour.asOf.slice(-8));

    await expect(
      runs.statistics({
        actorId: person,
        workspaceId: busyWorkspace,
        window: '6h',
      }),
    ).resolves.toMatchObject({
      window: {
        total: 12,
        byStatus: {
          ...zero,
          queued: 3,
          running: 2,
          succeeded: 3,
          failed: 3,
          timed_out: 1,
        },
      },
    });
    await expect(
      runs.statistics({
        actorId: person,
        workspaceId: busyWorkspace,
        window: '7d',
      }),
    ).resolves.toMatchObject({
      current: { queued: 3, running: 2, waiting: 1 },
      window: {
        total: 21,
        byStatus: {
          queued: 3,
          running: 2,
          waiting: 1,
          succeeded: 9,
          failed: 3,
          canceled: 1,
          timed_out: 1,
          outcome_unknown: 1,
        },
      },
    });

    const day = await runs.statistics({
      actorId: person,
      workspaceId: busyWorkspace,
      window: '24h',
      includeWorkflows: true,
      includeWorkflowName: true,
    });
    expect(day.window.total).toBe(16);
    expect(day.workflows).toEqual({
      truncated: false,
      items: [
        {
          workflowId: intake,
          workflowName: 'Invoice intake',
          total: 11,
          byStatus: {
            ...zero,
            succeeded: 5,
            failed: 3,
            timed_out: 1,
            outcome_unknown: 1,
            canceled: 1,
          },
        },
        {
          workflowId: sync,
          workflowName: 'Nightly sync',
          total: 5,
          byStatus: { ...zero, running: 2, queued: 3 },
        },
      ],
    });
    const unnamed = await runs.statistics({
      actorId: person,
      workspaceId: busyWorkspace,
      window: '24h',
      includeWorkflows: true,
    });
    expect(
      unnamed.workflows?.items.map(({ workflowName }) => workflowName),
    ).toEqual([null, null]);

    await expect(
      runs.statistics({
        actorId: person,
        workspaceId: quietWorkspace,
        window: '24h',
        includeWorkflows: true,
        includeWorkflowName: true,
      }),
    ).resolves.toMatchObject({
      current: { queued: 0, running: 1, waiting: 0 },
      window: { total: 8, byStatus: { ...zero, succeeded: 7, running: 1 } },
      workflows: {
        truncated: false,
        items: [{ workflowId: elsewhere, workflowName: 'Elsewhere' }],
      },
    });
  });
}
