import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import type { RunTransitionPlan } from '../src/runs/advance/plan.js';
import { persistWorkspaceInboxEvent } from '../src/inbox/producer.js';

const workspaceId = '018f2d7a-1c9b-7a42-9c3e-2f5a6b7c8d90';
const workflowId = '018f2d7a-1c9b-7a42-9c3e-2f5a6b7c8d91';
const runId = '018f2d7a-1c9b-7a42-9c3e-2f5a6b7c8d92';

function plan(
  runStatus: string,
  events: readonly { name: string; sequence: number }[],
): RunTransitionPlan {
  return {
    checkpoint: { runStatus },
    events: events.map((event) => ({
      ...event,
      occurredAt: '2026-09-28T10:01:00.000Z',
    })),
  } as unknown as RunTransitionPlan;
}

async function produce(
  input: Readonly<{
    plan: RunTransitionPlan;
    cancellationRequested?: boolean;
  }>,
) {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
  await persistWorkspaceInboxEvent({ query } as unknown as PoolClient, {
    workspaceId,
    workflowId,
    runId,
    cancellationRequested: input.cancellationRequested ?? false,
    plan: input.plan,
  });
  return query;
}

describe('workspace inbox producer', () => {
  it.each(['failed', 'timed_out', 'outcome_unknown'])(
    'records the %s terminal event once per run event',
    async (status) => {
      const query = await produce({
        plan: plan(status, [
          { name: 'node.failed', sequence: 4 },
          { name: `run.${status}`, sequence: 5 },
        ]),
      });
      expect(query).toHaveBeenCalledTimes(1);
      const [sql, values] = query.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/on conflict do nothing/u);
      expect(values.slice(1)).toEqual([
        workspaceId,
        workflowId,
        runId,
        5,
        status,
        '2026-09-28T10:01:00.000Z',
      ]);
    },
  );

  it.each([
    [
      'a succeeded run',
      plan('succeeded', [{ name: 'run.succeeded', sequence: 3 }]),
    ],
    [
      'a canceled run',
      plan('canceled', [{ name: 'run.canceled', sequence: 3 }]),
    ],
    [
      'a running transition',
      plan('running', [{ name: 'node.started', sequence: 3 }]),
    ],
    ['a failure without its terminal event', plan('failed', [])],
  ])('ignores %s', async (_case, transition) => {
    await expect(produce({ plan: transition })).resolves.not.toHaveBeenCalled();
  });

  it('ignores a failure that follows a cancellation request', async () => {
    const query = await produce({
      plan: plan('failed', [{ name: 'run.failed', sequence: 3 }]),
      cancellationRequested: true,
    });
    expect(query).not.toHaveBeenCalled();
  });
});
