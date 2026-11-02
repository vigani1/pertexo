import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { claimDispatchAttempt } from '../node-attempts/fixture.js';
import { asAdmin, checkpoint, insertRun } from '../fixtures.js';
import { AT, commit, nextSequence, type Invocation } from './support.js';

describe('a timed-out run and its workflow’s failure streak', () => {
  const outcomeOf = async (runId: string) => {
    const { rows } = await asAdmin((client) =>
      client.query<{ counts_as_failure: boolean }>(
        `select counts_as_failure from app.workflow_trigger_outcomes where run_id=$1`,
        [runId],
      ),
    );
    return rows[0]?.counts_as_failure;
  };

  const timeOut = async (
    runId: string,
    revision: number,
    invocations: readonly Invocation[] = [],
  ) => {
    const first = await nextSequence(runId);
    return commit(runId, {
      expectedRevision: revision,
      expectedNextEventSequence: first,
      consumedThroughEventSequence: first - 1,
      checkpoint: checkpoint({
        revision: revision + 1,
        runStatus: 'timed_out',
        deadlineExpired: true,
        nextEventSequence: first + 1,
        invocations,
      }),
      events: [{ sequence: first, name: 'run.timed_out', occurredAt: AT }],
      nodeRunAdmissions: [],
      attempts: [],
    });
  };

  // Overload is the platform's problem, and it shouldn't switch off someone's trigger.
  it('doesn’t count a run that only ever queued', async () => {
    const runId = await insertRun({ triggerType: 'webhook' });

    await timeOut(runId, 0);

    await expect(outcomeOf(runId)).resolves.toBeUndefined();
  });

  it('counts a run with a worker on a step when time ran out', async () => {
    const lease = await claimDispatchAttempt(`streak-${randomUUID()}`);
    await asAdmin((client) =>
      client.query(
        `update app.workflow_runs set trigger_type='webhook' where id=$1`,
        [lease.runId],
      ),
    );

    await timeOut(lease.runId, 1);

    await expect(outcomeOf(lease.runId)).resolves.toBe(true);
  });

  // No worker holds a step on a timer, but the workflow chose that wait.
  it('counts a run whose step was on its own timed wait', async () => {
    const key = 'waiting-step';
    const runId = await insertRun({
      triggerType: 'webhook',
      status: 'waiting',
      schedulerState: checkpoint({
        runStatus: 'waiting',
        invocations: [
          {
            invocationKey: key,
            nodeId: key,
            status: 'waiting',
            attemptNumber: 1,
            resumeAt: '2099-01-01T00:00:00.000Z',
            waitKind: 'node_wait',
          },
        ],
      }),
    });

    await timeOut(runId, 0);

    await expect(outcomeOf(runId)).resolves.toBe(true);
  });

  it('counts neither way for a run started by hand', async () => {
    const lease = await claimDispatchAttempt(`by-hand-${randomUUID()}`);

    await timeOut(lease.runId, 1);

    await expect(outcomeOf(lease.runId)).resolves.toBeUndefined();
  });
});
