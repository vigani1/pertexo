import { describe, expect, it } from 'vitest';

import {
  CoordinatorRunStateCorruptError,
  asAdmin,
  checkpoint,
  insertRun,
  ownedDeliveryStore,
  workspaceA,
} from '../fixtures.js';
import { runWithSteps, statementsDuring } from './support.js';

describe('the waiting steps an advance looks up', () => {
  const load = (runId: string) =>
    ownedDeliveryStore.loadAdvanceState({ workspaceId: workspaceA, runId });

  const readsDueSteps = (statements: readonly string[]) =>
    statements.filter(
      (text) =>
        text.includes('coalesce("retry_due_at"') ||
        text.includes('coalesce("node_runs"."retry_due_at"'),
    );

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

  it('sends no query for due steps when nothing is waiting, and one when something is', async () => {
    const idle = await runWithSteps(['idle']);
    const sleeping = await insertRun({
      schedulerState: checkpoint({
        runStatus: 'waiting',
        invocations: [
          {
            invocationKey: 'sleeping',
            nodeId: 'sleeping',
            status: 'waiting',
            attemptNumber: 1,
          },
        ],
      }),
    });

    const forIdle = await statementsDuring(() => load(idle));
    const forSleeping = await statementsDuring(() => load(sleeping));

    expect(readsDueSteps(forIdle)).toEqual([]);
    expect(readsDueSteps(forSleeping)).toHaveLength(1);
  });
});
