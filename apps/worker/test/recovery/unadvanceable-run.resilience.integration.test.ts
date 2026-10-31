import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  describeFaults,
  RECOVERY_LIMIT_MS,
  SCENARIO_LIMIT_MS,
} from '../support/recovery/environment.js';
import {
  activeRuns,
  delay,
  waitForRunsToEnd,
  type RunFacts,
} from '../support/recovery/facts.js';
import { nextStep, slowStep, startFlow } from '../support/recovery/flows.js';
import { startStack, type Stack } from '../support/recovery/stack.js';

const DISPATCH_LIMIT_MS = 30_000;
const DISPATCHER_LIMIT_MS = 30_000;

describeFaults('a run the engine can never advance', () => {
  let stack: Stack;
  let runId: string;
  let badEventId: string;
  let facts: Readonly<Record<string, RunFacts>>;
  let active: number;
  let list: string;

  beforeAll(async () => {
    stack = await startStack('unadvanceable-run');
    const workspace = await stack.api.createWorkspace('recovery-corrupt');
    runId = await startFlow(stack, workspace, 'corrupt', [
      slowStep(stack, 'corrupt', 'POST', 3),
      nextStep(stack, 'after-corrupt'),
    ]);
    await stack.sink.waitForCalls('corrupt', 1, DISPATCH_LIMIT_MS);
    await stack.sql(
      `update app.run_checkpoints set scheduler_state='{"corrupt":true}'::jsonb
        where workflow_run_id=$1`,
      [runId],
    );

    // A row that can never publish: its checksum doesn't match its payload.
    badEventId = randomUUID();
    await stack.sql(
      `insert into app.outbox_events
         (id, workspace_id, job_name, aggregate_type, aggregate_id, payload, payload_checksum)
       values ($1, $2, 'deliver-run-failure-notification', 'run-failure-notification', $3,
               '{}'::jsonb, repeat('0', 64))`,
      [badEventId, workspace, randomUUID()],
    );
    const deadline = Date.now() + DISPATCHER_LIMIT_MS;
    for (;;) {
      const [row] = await stack.sql<{ failed_at: Date | null }>(
        `select failed_at from app.outbox_events where id=$1`,
        [badEventId],
      );
      if (row?.failed_at instanceof Date) break;
      if (Date.now() > deadline)
        throw new Error('The dispatcher never refused the broken event');
      await delay(100);
    }

    facts = await waitForRunsToEnd(stack, [runId], RECOVERY_LIMIT_MS);
    active = await activeRuns(stack, workspace);

    const operator = stack.operator({
      OPERATOR_COMMAND_TYPE: 'stuck-work.list',
    });
    operator.startOnce();
    await delay(5_000);
    await operator.stop('SIGKILL');
    list = operator.logs.map(({ text }) => text).join('\n');
  }, SCENARIO_LIMIT_MS);

  afterAll(async () => {
    await stack.close();
  }, SCENARIO_LIMIT_MS);

  // backend-gaps-02: an unrecoverable delivery writes nothing to the run.
  it('fails the run with a reason instead of leaving it running', () => {
    expect(facts[runId]?.status).toBe('failed');
  });

  // backend-gaps-02, reliability-03: a run that can't move must not keep its slot.
  it('releases its slot', () => {
    expect(active).toBe(0);
  });

  it('never sends the step twice, and runs no later step', () => {
    expect(stack.sink.calls('corrupt')).toHaveLength(1);
    expect(stack.sink.calls('after-corrupt')).toHaveLength(0);
  });

  // backend-gaps-03, ops-08, reliability-10: job failures reach only Redis's failedReason.
  it('logs the failed delivery at warn or above, naming the run', () => {
    expect(stack.worker.linesMentioning([runId], 'warn')).not.toEqual([]);
  });

  // reliability-10: outbox failures have no listing, only one-id-at-a-time repair.
  it('lists the failed outbox event for the operator', () => {
    expect(list).toContain(badEventId);
  });
});
