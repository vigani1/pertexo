import { describe, expect, it } from 'vitest';
import {
  asAdmin,
  asRuntime,
  insertRun,
  workerBaseUrl,
  workflowA,
  workspaceA,
} from '../runs/run-store/run-store.fixture.js';

import type { WorkflowTransitionPlan } from '@pertexo/workflow-engine';
import { persistWorkspaceInboxEvent } from '../../src/inbox/folding/events.repository.js';

function plan(
  runStatus: string,
  events: readonly { name: string; sequence: number }[],
): WorkflowTransitionPlan {
  return {
    checkpoint: { runStatus },
    events: events.map((event) => ({
      ...event,
      occurredAt: '2026-09-28T10:01:00.000Z',
    })),
  } as unknown as WorkflowTransitionPlan;
}

async function produce(
  input: Readonly<{
    plan: WorkflowTransitionPlan;
    cancellationRequested?: boolean;
  }>,
) {
  const runId = await insertRun({});
  await asRuntime(workerBaseUrl, workspaceA, async (client) => {
    const event = {
      workspaceId: workspaceA,
      workflowId: workflowA,
      runId,
      cancellationRequested: input.cancellationRequested ?? false,
      plan: input.plan,
    };
    await persistWorkspaceInboxEvent(client, event);
    await persistWorkspaceInboxEvent(client, event);
  });
  return asAdmin(
    async (pool) =>
      (
        await pool.query<Record<string, unknown>>(
          'select workspace_id, workflow_id, terminal_event_sequence, kind, occurred_at from app.workspace_inbox_events where run_id=$1',
          [runId],
        )
      ).rows,
  );
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
      expect(query).toEqual([
        {
          workspace_id: workspaceA,
          workflow_id: workflowA,
          terminal_event_sequence: '5',
          kind: status,
          occurred_at: new Date('2026-09-28T10:01:00.000Z'),
        },
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
    await expect(produce({ plan: transition })).resolves.toEqual([]);
  });

  it('ignores a failure that follows a cancellation request', async () => {
    const query = await produce({
      plan: plan('failed', [{ name: 'run.failed', sequence: 3 }]),
      cancellationRequested: true,
    });
    expect(query).toEqual([]);
  });
});
