// @vitest-environment node
import type { WorkflowRunReadSummary } from '@pertexo/contracts/schemas/workflow-runs';
import { describe, expect, it } from 'vitest';
import {
  firstThreadSteps,
  isNewWorkspace,
} from '@/features/overview/model/first-thread';
import {
  destinationAttentionItems,
  runAttentionItems,
  workflowAttentionItems,
} from '@/features/overview/model/needs-attention';
import {
  hitTestLoom,
  loomLaneY,
  loomLayout,
  loomX,
  shapeLoom,
} from '@/features/workflow-runs/model/loom';
import {
  groupRunsByDay,
  threadBarScale,
} from '@/features/workflow-runs/model/run-list';

const now = Date.parse('2026-09-24T14:00:00.000Z');
const minute = 60_000;

function run(
  id: string,
  workflowId: string,
  status: WorkflowRunReadSummary['status'],
  startMinutesAgo: number,
  endMinutesAgo: number | null,
): WorkflowRunReadSummary {
  const started = new Date(now - startMinutesAgo * minute).toISOString();
  return {
    id,
    workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    workflowId,
    workflowVersionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    workflowName: workflowId === 'wf-a' ? 'Invoice intake' : 'Lead enrichment',
    status,
    triggerType: 'webhook',
    createdAt: started,
    updatedAt:
      endMinutesAgo === null
        ? started
        : new Date(now - endMinutesAgo * minute).toISOString(),
    startedAt: started,
    completedAt:
      endMinutesAgo === null
        ? null
        : new Date(now - endMinutesAgo * minute).toISOString(),
    deadlineAt: null,
    cancelRequestedAt: null,
  };
}

describe('loom', () => {
  it('shapes one lane per workflow, keeps active runs open and drops old ones', () => {
    const model = shapeLoom(
      [
        run('r1', 'wf-a', 'succeeded', 50, 49),
        run('r2', 'wf-a', 'running', 5, null),
        run('r2', 'wf-a', 'running', 5, null),
        run('r3', 'wf-b', 'failed', 30, 29),
        run('r4', 'wf-b', 'succeeded', 120, 90),
        run('r5', 'wf-b', 'running', 90, null),
      ],
      { windowMs: 60 * minute, nowMs: now },
    );
    expect(model.lanes.map((lane) => lane.label)).toEqual([
      'Invoice intake',
      'Lead enrichment',
    ]);
    expect(model.runCount).toBe(4);
    expect(model.liveCount).toBe(2);
    expect(model.lanes[0]?.runs.map((entry) => entry.id)).toEqual(['r1', 'r2']);
    expect(model.lanes[0]?.runs[1]?.endMs).toBeNull();
    expect(model.ticks[0]).toEqual({ offsetMs: 0, label: 'now' });
    expect(model.ticks).toHaveLength(7);
  });

  it('keeps only the busiest lanes and says how many are hidden', () => {
    const runs = Array.from({ length: 10 }, (_, index) =>
      run(
        `r${String(index)}`,
        `wf-${String(index)}`,
        'succeeded',
        20,
        10 + index,
      ),
    );
    const model = shapeLoom(runs, {
      windowMs: 60 * minute,
      nowMs: now,
      maxLanes: 8,
    });
    expect(model.lanes).toHaveLength(8);
    expect(model.hiddenLaneCount).toBe(2);
  });

  it('hit-tests the thread under the pointer', () => {
    const model = shapeLoom(
      [
        run('r1', 'wf-a', 'succeeded', 40, 20),
        run('r2', 'wf-b', 'running', 10, null),
      ],
      { windowMs: 60 * minute, nowMs: now },
    );
    const layout = loomLayout(model, 1000, 320);
    const x = loomX(layout, model.windowMs, now, now - 30 * minute);
    expect(hitTestLoom(model, layout, now, x, loomLaneY(layout, 1))?.id).toBe(
      'r1',
    );
    expect(
      hitTestLoom(model, layout, now, x, loomLaneY(layout, 0)),
    ).toBeUndefined();
    expect(layout.core.x).toBe(1000 - 95);
  });
});

describe('run list', () => {
  it('groups by local day and scales thread bars on a log scale', () => {
    const groups = groupRunsByDay(
      [
        run('r1', 'wf-a', 'succeeded', 10, 9),
        run('r2', 'wf-a', 'succeeded', 60 * 24 * 3, 60 * 24 * 3 - 1),
      ],
      now,
    );
    expect(groups.map((group) => group.runs.length)).toEqual([1, 1]);
    expect(groups[0]?.heading).toBe('Today');
    const scale = threadBarScale([1_000, 1_200_000]);
    expect(scale(1_200_000)).toBe(1);
    expect(scale(2_000)).toBeGreaterThan(0.4);
    expect(scale(undefined)).toBe(0);
  });
});

describe('needs attention', () => {
  it('groups problem runs by workflow with the latest run to open', () => {
    const items = runAttentionItems(
      {
        failed: [
          run('f1', 'wf-a', 'failed', 50, 49),
          run('f2', 'wf-a', 'failed', 20, 19),
        ],
        timedOut: [run('t1', 'wf-b', 'timed_out', 30, 20)],
        outcomeUnknown: [],
      },
      now,
    );
    expect(items.map((item) => item.title)).toEqual([
      'Invoice intake failed twice in the last 24 hours',
      'Lead enrichment timed out once in the last 24 hours',
    ]);
    expect(items[0]).toMatchObject({
      tone: 'failure',
      action: { kind: 'run', runId: 'f2' },
    });
  });

  it('flags unhealthy triggers and disabled alert destinations', () => {
    const workflow = {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      name: 'Nightly CRM sync',
      lifecycleStatus: 'active' as const,
      lifecycleRevision: 1,
      activationStatus: 'degraded' as const,
      publishedVersionId: null,
      createdAt: '2026-09-24T10:00:00.000Z',
      updatedAt: '2026-09-24T10:00:00.000Z',
    };
    expect(workflowAttentionItems([workflow])[0]).toMatchObject({
      title: 'Nightly CRM sync is degraded',
      action: { kind: 'triggers', workflowId: workflow.id },
    });
    expect(
      workflowAttentionItems([{ ...workflow, activationStatus: 'active' }]),
    ).toEqual([]);
    const destination = {
      id: '77777777-7777-4777-8777-777777777777',
      workspaceId: workflow.workspaceId,
      kind: 'slack' as const,
      status: 'disabled' as const,
      currentVersion: 1,
      config: {
        kind: 'slack' as const,
        connectionId: '88888888-8888-4888-8888-888888888888',
        channelId: 'C123',
      },
      createdAt: workflow.createdAt,
      updatedAt: workflow.updatedAt,
    };
    expect(destinationAttentionItems([destination])[0]?.title).toBe(
      'A failure alert destination is turned off',
    );
  });
});

describe('first thread', () => {
  it('derives steps from real reads and hides what the role cannot check', () => {
    const steps = firstThreadSteps({ workflows: [], hasRun: false });
    expect(steps.map((step) => [step.key, step.done])).toEqual([
      ['create', false],
      ['publish', false],
      ['run', false],
    ]);
    expect(
      firstThreadSteps({ connectionCount: 1, memberCount: 1 }).map((step) => [
        step.key,
        step.done,
      ]),
    ).toEqual([
      ['connection', true],
      ['invite', false],
    ]);
    expect(isNewWorkspace({ hasRun: false })).toBe(true);
    expect(isNewWorkspace({ hasRun: true, workflows: [] })).toBe(false);
    expect(isNewWorkspace({ workflows: [] })).toBe(true);
    expect(isNewWorkspace({})).toBe(false);
  });
});
