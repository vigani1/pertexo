import { describe, expect, it } from 'vitest';

import {
  CoordinatorRunStateCorruptError,
  asAdmin,
  checkpoint,
  insertRun,
  ownedDeliveryStore,
  workspaceA,
  versionA,
  randomUUID,
} from '../fixtures.js';

describe('the waiting steps an advance looks up', () => {
  const load = (runId: string) =>
    ownedDeliveryStore.loadAdvanceState({ workspaceId: workspaceA, runId });

  // A checkpoint this advance can't read tells it nothing about what's due, so it
  // stops: guessing "nothing's waiting" would leave those steps asleep for good.
  it.each([
    ['steps that aren’t a list', { nextEventSequence: 2, invocations: 'many' }],
    [
      'a step with no key',
      { nextEventSequence: 2, invocations: [{ status: 'waiting' }] },
    ],
    ['no steps at all', { nextEventSequence: 2 }],
  ])('fails closed on a checkpoint with %s', async (_name, damage) => {
    const runId = await insertRun({});
    await asAdmin((client) =>
      client.query(
        `update app.run_checkpoints set scheduler_state=$2::jsonb where workflow_run_id=$1`,
        [runId, JSON.stringify(damage)],
      ),
    );

    await expect(load(runId)).rejects.toBeInstanceOf(
      CoordinatorRunStateCorruptError,
    );
  });

  it('observes only physical waits that are due and already waiting in this checkpoint', async () => {
    const key = (nodeId: string) => `${versionA}|${nodeId}|b:|i:`;
    const runId = await insertRun({
      status: 'waiting',
      schedulerState: checkpoint({
        runStatus: 'waiting',
        invocations: ['due', 'future', 'retry'].map((nodeId) => ({
          invocationKey: key(nodeId),
          nodeId,
          status: 'waiting',
          attemptNumber: 0,
        })),
      }),
    });
    const otherRunId = await insertRun({});
    const expected: {
      kind: 'due_at';
      invocationKey: string;
      occurredAt: string;
    }[] = [];
    await asAdmin(async (client) => {
      for (const [nodeId, kind, minutes, owner] of [
        ['due', 'node_wait', -1, runId],
        ['future', 'node_wait', 60, runId],
        ['retry', 'retry_backoff', -2, runId],
        ['not-in-checkpoint', 'node_wait', -3, runId],
        ['foreign', 'node_wait', -4, otherRunId],
      ] as const) {
        const stored = await client.query<{ due_at: Date }>(
          `insert into app.node_runs(id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,status,side_effect_class,wait_kind,resume_at,retry_due_at)
          values($1,$2,$3,$4,$5,'{}','waiting','safe',$6::varchar,
            case when $6::varchar='node_wait' then clock_timestamp()+($7::int*interval '1 minute') end,
            case when $6::varchar='retry_backoff' then clock_timestamp()+($7::int*interval '1 minute') end) returning coalesce(resume_at,retry_due_at) due_at`,
          [randomUUID(), workspaceA, owner, nodeId, key(nodeId), kind, minutes],
        );
        if (nodeId === 'due' || nodeId === 'retry') {
          const row = stored.rows[0];
          if (row === undefined) throw new Error('Waiting row not stored');
          expected.push({
            kind: 'due_at',
            invocationKey: key(nodeId),
            occurredAt: row.due_at.toISOString(),
          });
        }
      }
    });
    const result = await load(runId);
    expect(result).toMatchObject({ kind: 'ready' });
    if (result.kind !== 'ready') throw new Error('Waiting run unavailable');
    expect(result.state.observations).toEqual(expected);
  });
});
