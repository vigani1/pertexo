import { describe, expect, it } from 'vitest';

import { CoordinatorRunStateCorruptError, asAdmin } from '../fixtures.js';
import {
  commit,
  keysFor,
  nextSequence,
  runWithSteps,
  settlePlan,
  statementsDuring,
  stepRows,
} from './support.js';

describe('settling steps in one statement', () => {
  // As many as a checkpoint here can hold: its stored form is limited to 10,000 members.
  it('settles over a thousand steps with the same work as a handful', async () => {
    const small = keysFor('small', 5);
    const large = keysFor('large', 1_500);
    const smallRun = await runWithSteps(small);
    const largeRun = await runWithSteps(large);
    const canceled = (keys: readonly string[]) =>
      keys.map((key) => ({
        key,
        name: 'node.canceled',
        reasonCode: 'run_canceled',
      }));
    const smallPlan = await settlePlan(smallRun, canceled(small));
    const largePlan = await settlePlan(largeRun, canceled(large));

    const forSmall = await statementsDuring(() => commit(smallRun, smallPlan));
    const forLarge = await statementsDuring(() => commit(largeRun, largePlan));

    const rows = await stepRows(largeRun);
    expect(rows.size).toBe(1_500);
    for (const row of rows.values())
      expect(row).toMatchObject({
        status: 'canceled',
        safe_error_code: 'run_canceled',
        completed: true,
      });
    // Events are written a thousand at a time, and nothing else grows with the steps.
    expect(forLarge.length - forSmall.length).toBeLessThanOrEqual(3);
  }, 120_000);

  it('stores each kind of ending, with an error code on all but success', async () => {
    const endings = {
      failed: 'node.failed',
      canceled: 'node.canceled',
      timedOut: 'node.timed_out',
      unknown: 'node.outcome_unknown',
    } as const;
    const keys = Object.keys(endings);
    const runId = await runWithSteps(keys);

    await commit(
      runId,
      await settlePlan(
        runId,
        Object.entries(endings).map(([key, name]) => ({
          key,
          name,
          reasonCode: `because_${key.toLowerCase()}`,
        })),
      ),
    );

    const rows = await stepRows(runId);
    expect(rows.get('failed')).toMatchObject({
      status: 'failed',
      safe_error_code: 'because_failed',
    });
    expect(rows.get('canceled')).toMatchObject({
      status: 'canceled',
      safe_error_code: 'because_canceled',
    });
    expect(rows.get('timedOut')).toMatchObject({
      status: 'timed_out',
      safe_error_code: 'because_timedout',
    });
    expect(rows.get('unknown')).toMatchObject({
      status: 'outcome_unknown',
      safe_error_code: 'because_unknown',
    });
  });

  // Two events can't end one step. It isn't a thing to settle quietly, since one of
  // them is wrong and the checkpoint says which it believed: nothing is written.
  it('refuses a duplicate event for a step, and writes nothing', async () => {
    const keys = ['once', 'twice'];
    const runId = await runWithSteps(keys);
    const plan = await settlePlan(runId, [
      { key: 'once', name: 'node.canceled', reasonCode: 'run_canceled' },
      { key: 'twice', name: 'node.canceled', reasonCode: 'run_canceled' },
      { key: 'twice', name: 'node.failed', reasonCode: 'other_ending' },
    ]);

    await expect(commit(runId, plan)).rejects.toBeInstanceOf(
      CoordinatorRunStateCorruptError,
    );

    const rows = await stepRows(runId);
    expect(rows.get('once')?.status).not.toBe('canceled');
    expect(rows.get('twice')?.status).not.toBe('canceled');
    expect(await nextSequence(runId)).toBe(plan.expectedNextEventSequence);
  });

  it('refuses an ending for a step that has ended, and writes nothing', async () => {
    const keys = ['already', 'open'];
    const runId = await runWithSteps(keys);
    await asAdmin((client) =>
      client.query(
        `update app.node_runs set status='canceled',safe_error_code='earlier',completed_at=clock_timestamp()
          where workflow_run_id=$1 and invocation_key='already'`,
        [runId],
      ),
    );

    await expect(
      commit(
        runId,
        await settlePlan(runId, [
          { key: 'already', name: 'node.failed', reasonCode: 'late' },
          { key: 'open', name: 'node.failed', reasonCode: 'late' },
        ]),
      ),
    ).rejects.toBeInstanceOf(CoordinatorRunStateCorruptError);

    const rows = await stepRows(runId);
    expect(rows.get('already')).toMatchObject({
      status: 'canceled',
      safe_error_code: 'earlier',
    });
    expect(rows.get('open')?.safe_error_code).toBeNull();
  });
});

describe('settling alongside a For each that went over its limit', () => {
  // The step that made the list already succeeded, and failing it is a separate write.
  it('fails the step that made the list, and settles the others', async () => {
    const runId = await runWithSteps(['list', 'other']);
    await asAdmin((client) =>
      client.query(
        `update app.node_runs
            set status='succeeded',completed_at=clock_timestamp(),
                output_ref='{"kind":"inline","value":[1]}'::jsonb
          where workflow_run_id=$1 and invocation_key='list'`,
        [runId],
      ),
    );

    await commit(
      runId,
      await settlePlan(runId, [
        { key: 'list', name: 'node.failed', reasonCode: 'loop_limit_exceeded' },
        { key: 'other', name: 'node.canceled', reasonCode: 'run_canceled' },
      ]),
    );

    const rows = await stepRows(runId);
    expect(rows.get('list')).toMatchObject({
      status: 'failed',
      safe_error_code: 'loop_limit_exceeded',
    });
    expect(rows.get('other')).toMatchObject({
      status: 'canceled',
      safe_error_code: 'run_canceled',
    });
  });
});
