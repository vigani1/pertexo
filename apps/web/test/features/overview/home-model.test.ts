// @vitest-environment node
import type {
  ConnectionResponse,
  WorkflowRunReadSummary,
} from '@pertexo/contracts';
import { describe, expect, it } from 'vitest';
import { loomCaption } from '@/features/overview/model/loom-caption';
import {
  taskAttentionItems,
  connectionAttentionItems,
  destinationAttentionItems,
  runAttentionItems,
  workflowAttentionItems,
} from '@/features/overview/model/needs-attention';
import { shapeLoom } from '@/features/workflow-runs/model/loom/model';
import { groupRunsByDay } from '@/features/workflow-runs/model/list/runs';

const now = Date.parse('2026-09-24T14:00:00.000Z');
const minute = 60_000;

function run({
  id,
  workflowId,
  status,
  startMinutesAgo,
  endMinutesAgo,
}: Readonly<{
  id: string;
  workflowId: string;
  status: WorkflowRunReadSummary['status'];
  startMinutesAgo: number;
  endMinutesAgo: number | null;
}>): WorkflowRunReadSummary {
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
        run({
          id: 'r1',
          workflowId: 'wf-a',
          status: 'succeeded',
          startMinutesAgo: 50,
          endMinutesAgo: 49,
        }),
        run({
          id: 'r2',
          workflowId: 'wf-a',
          status: 'running',
          startMinutesAgo: 5,
          endMinutesAgo: null,
        }),
        run({
          id: 'r2',
          workflowId: 'wf-a',
          status: 'running',
          startMinutesAgo: 5,
          endMinutesAgo: null,
        }),
        run({
          id: 'r3',
          workflowId: 'wf-b',
          status: 'failed',
          startMinutesAgo: 30,
          endMinutesAgo: 29,
        }),
        run({
          id: 'r4',
          workflowId: 'wf-b',
          status: 'succeeded',
          startMinutesAgo: 120,
          endMinutesAgo: 90,
        }),
        run({
          id: 'r5',
          workflowId: 'wf-b',
          status: 'running',
          startMinutesAgo: 90,
          endMinutesAgo: null,
        }),
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
      run({
        id: `r${String(index)}`,
        workflowId: `wf-${String(index)}`,
        status: 'succeeded',
        startMinutesAgo: 20,
        endMinutesAgo: 10 + index,
      }),
    );
    const model = shapeLoom(runs, {
      windowMs: 60 * minute,
      nowMs: now,
      maxLanes: 8,
    });
    expect(model.lanes).toHaveLength(8);
    expect(model.hiddenLaneCount).toBe(2);
  });

  it('carries exact window totals only for lanes the statistics read knows', () => {
    const model = shapeLoom(
      [
        run({
          id: 'r1',
          workflowId: 'wf-a',
          status: 'succeeded',
          startMinutesAgo: 50,
          endMinutesAgo: 49,
        }),
        run({
          id: 'r2',
          workflowId: 'wf-b',
          status: 'failed',
          startMinutesAgo: 30,
          endMinutesAgo: 29,
        }),
      ],
      {
        windowMs: 60 * minute,
        nowMs: now,
        laneTotals: new Map([['wf-a', 420]]),
      },
    );
    expect(
      model.lanes.map((lane) => [lane.key, lane.total ?? 'unknown']),
    ).toEqual([
      ['wf-b', 'unknown'],
      ['wf-a', 420],
    ]);
  });

  it('captions the timeline with the true total and says when it draws only some', () => {
    const phrase = 'the last 24 hours';
    expect(loomCaption({ phrase, capped: false, total: 1 })).toBe(
      '1 run in the last 24 hours.',
    );
    expect(loomCaption({ phrase, capped: true, total: 1234 })).toBe(
      '1,234 runs in the last 24 hours. The timeline shows the latest 300; narrow the window to see every run.',
    );
    expect(loomCaption({ phrase, capped: true, total: undefined })).toBe(
      'Showing the latest 300 runs in the last 24 hours. Narrow the window to see every run.',
    );
    expect(
      loomCaption({ phrase, capped: false, total: undefined }),
    ).toBeUndefined();
  });
});

describe('run list', () => {
  it('groups by local day', () => {
    const groups = groupRunsByDay(
      [
        run({
          id: 'r1',
          workflowId: 'wf-a',
          status: 'succeeded',
          startMinutesAgo: 10,
          endMinutesAgo: 9,
        }),
        run({
          id: 'r2',
          workflowId: 'wf-a',
          status: 'succeeded',
          startMinutesAgo: 60 * 24 * 3,
          endMinutesAgo: 60 * 24 * 3 - 1,
        }),
      ],
      now,
    );
    expect(groups.map((group) => group.runs.length)).toEqual([1, 1]);
    expect(groups[0]?.heading).toBe('Today');
  });
});

describe('needs attention', () => {
  it('puts requests you can answer first, soonest deadline first', () => {
    const task = (id: string, expiresAt: string, canRespond = true) =>
      ({
        id,
        title: `Approve ${id}`,
        workflowName: 'Invoice intake',
        status: 'pending',
        canRespond,
        expiresAt,
      }) as Parameters<typeof taskAttentionItems>[0][number];
    const items = taskAttentionItems([
      task('later', '2026-09-25T10:00:00.000Z'),
      task('theirs', '2026-09-24T14:10:00.000Z', false),
      task('soon', '2026-09-24T15:00:00.000Z'),
    ]);
    expect(items.map((item) => item.key)).toEqual([
      'request:soon',
      'request:later',
    ]);
    expect(items[0]).toMatchObject({
      tone: 'waiting',
      detail: 'Invoice intake',
      deadline: '2026-09-24T15:00:00.000Z',
      action: { kind: 'task', taskId: 'soon' },
    });
  });
  it('groups problem runs by workflow with the latest run to open', () => {
    const items = runAttentionItems(
      {
        failed: [
          run({
            id: 'f1',
            workflowId: 'wf-a',
            status: 'failed',
            startMinutesAgo: 50,
            endMinutesAgo: 49,
          }),
          run({
            id: 'f2',
            workflowId: 'wf-a',
            status: 'failed',
            startMinutesAgo: 20,
            endMinutesAgo: 19,
          }),
        ],
        timedOut: [
          run({
            id: 't1',
            workflowId: 'wf-b',
            status: 'timed_out',
            startMinutesAgo: 30,
            endMinutesAgo: 20,
          }),
        ],
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
      nameRevision: 1,
      lifecycleStatus: 'active' as const,
      lifecycleRevision: 1,
      activationStatus: 'degraded' as const,
      webhookSetupRequired: false,
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

describe('connections that need attention', () => {
  const connection = (lastErrorCode: string) =>
    ({
      id: 'connection-1',
      name: 'Billing API',
      status: 'reauthorization_required',
      health: { lastErrorCode },
    }) as unknown as ConnectionResponse;

  // M4: nothing uses a brand-new connection and nobody has connected it yet.
  it('M4 says nothing about a connection nobody has connected yet', () => {
    expect(
      connectionAttentionItems({
        connections: [connection('connection.oauth2_not_authorized')],
        canManage: true,
      }),
    ).toEqual([]);
  });

  it('still says a connection that lost its grant needs reconnecting', () => {
    expect(
      connectionAttentionItems({
        connections: [connection('connection.oauth2_grant_revoked')],
        canManage: true,
      }),
    ).toEqual([
      {
        key: 'connection:connection-1',
        tone: 'attention',
        title: 'Billing API needs reconnecting',
        detail: 'Steps that use it fail until it’s reconnected.',
        action: { kind: 'connections' },
      },
    ]);
  });
});
