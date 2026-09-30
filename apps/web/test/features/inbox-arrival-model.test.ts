import type { WorkspaceInboxThread } from '@pertexo/contracts/schemas/workspace-inbox';
import { describe, expect, it } from 'vitest';
import {
  arrivedThreads,
  describeInboxArrival,
  mergeArrivals,
} from '@/features/inbox/model/inbox-arrival';

function thread(
  workflowId: string,
  overrides: Partial<WorkspaceInboxThread> = {},
): WorkspaceInboxThread {
  return {
    workflowId,
    workflowName: `Workflow ${workflowId.slice(0, 1)}`,
    kind: 'failed',
    occurrenceCount: 1,
    firstOccurredAt: '2026-09-15T09:00:00.000000Z',
    latestOccurredAt: '2026-09-15T09:30:00.000000Z',
    latestRunId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    latestFailedStep: null,
    revision: '7',
    unread: true,
    ...overrides,
  };
}

const first = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const third = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('inbox arrivals', () => {
  it('keeps unread notices that changed after the revision the tab saw', () => {
    // Beyond Number.MAX_SAFE_INTEGER, where float comparison loses the order.
    const seen = '9007199254740992';
    const arrived = arrivedThreads(
      [
        thread(first, { revision: '9007199254740993' }),
        thread(second, { revision: seen }),
        thread(third, { revision: '9007199254740994', unread: false }),
      ],
      seen,
    );
    expect(arrived.map((item) => item.workflowId)).toEqual([first]);
  });

  it('merges arrivals into one entry per workflow, newest first', () => {
    const merged = mergeArrivals(
      [thread(first, { revision: '8' }), thread(second, { revision: '9' })],
      [
        thread(first, { revision: '11', occurrenceCount: 2 }),
        thread(third, { revision: '10' }),
      ],
    );
    expect(merged.map((item) => [item.workflowId, item.revision])).toEqual([
      [first, '11'],
      [third, '10'],
      [second, '9'],
    ]);
    expect(merged[0]?.occurrenceCount).toBe(2);
  });

  it('describes one workflow by its failure, how often and where', () => {
    const view = describeInboxArrival([
      thread(first, {
        workflowName: 'Nightly import',
        occurrenceCount: 7,
        latestFailedStep: {
          nodeId: 'fetch',
          label: 'Fetch orders',
          definitionKey: 'core.http',
          safeErrorCode: null,
        },
      }),
    ]);
    expect(view).toMatchObject({
      tone: 'failure',
      kicker: 'Failed',
      title: 'Nightly import',
      marks: ['failure', 'failure', 'failure', 'failure', 'failure'],
      more: 2,
    });
    expect(view.detail).toMatch(/^Failed 7 times since .+ · at Fetch orders$/u);
    expect(view.thread?.workflowId).toBe(first);
  });

  it('groups several workflows and marks each by how it failed', () => {
    const view = describeInboxArrival([
      thread(first, { workflowName: 'Nightly import' }),
      thread(second, { workflowName: 'Billing sync', kind: 'timed_out' }),
      thread(third, { workflowName: 'Invoice push' }),
    ]);
    expect(view).toMatchObject({
      kicker: '3 workflows',
      title: 'Several workflows are failing',
      detail: 'Nightly import, Billing sync and 1 more',
      marks: ['failure', 'timeout', 'failure'],
      more: 0,
    });
    expect(view.thread).toBeUndefined();
  });
});
