import { QUEUE_NAME } from '@pertexo/queue';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  describeFaults,
  RECOVERY_LIMIT_MS,
  SCENARIO_LIMIT_MS,
} from '../../support/recovery/environment.js';
import {
  delay,
  factsOfRun,
  waitForRunsToEnd,
  type RunFacts,
} from '../../support/recovery/facts.js';
import {
  failingStep,
  nextStep,
  slowStep,
  startFlow,
} from '../../support/recovery/flows.js';
import { httpChain } from '../../support/recovery/graphs.js';
import {
  eventsOfAggregate,
  pauseQueue,
  waitForAggregatePublished,
  waitForPublished,
  waitForReadyAttempts,
} from '../../support/recovery/queues.js';
import { startStack, type Stack } from '../../support/recovery/stack.js';

const DISPATCH_LIMIT_MS = 30_000;
const STEP_SECONDS = 15;
// Time for the first asking, due at once, to reach its consumer and fail there.
const FIRST_ASKING_MS = 20_000;
// Past the 5 s between scans.
const SCAN_MS = 8_000;

/**
 * Migration 0060 adds `delivery_due_at` with no value. A job published before the
 * upgrade and lost around it, a Redis that didn't survive the same restart, has
 * the row shape made here: published, with no due time. These are the runs the
 * scanner was written for, already stranded on the day it arrives.
 */
describeFaults(
  'run jobs published before the due time existed, then lost',
  () => {
    let stack: Stack;
    let facts: Readonly<Record<string, RunFacts>>;
    const runs: Record<string, string> = {};

    beforeAll(async () => {
      stack = await startStack('published-before-upgrade');
      const workspace = await stack.api.createWorkspace('recovery-upgrade');

      // A step long enough to set up the attempt job below while it is still running.
      runs.advance = await startFlow(stack, workspace, 'advance', [
        slowStep(stack, 'old-advance', 'POST', STEP_SECONDS),
        nextStep(stack, 'after-old-advance'),
      ]);
      await stack.sink.waitForCalls('old-advance', 1, DISPATCH_LIMIT_MS);
      const eventsBeforeStepEnds = await eventsOfAggregate(stack, runs.advance);

      await pauseQueue(stack, QUEUE_NAME.nodeAttempts);
      runs.attempt = await startFlow(stack, workspace, 'attempt', [
        nextStep(stack, 'old-attempt'),
      ]);
      await waitForReadyAttempts(stack, [runs.attempt], 1);
      await waitForPublished(stack, { 'execute-node-attempt': 2 });

      await pauseQueue(stack, QUEUE_NAME.workflowCoordinator);
      await waitForAggregatePublished(
        stack,
        runs.advance,
        eventsBeforeStepEnds + 1,
      );
      await stack.worker.stop('SIGKILL');

      await stack.sql(
        `update app.outbox_events set delivery_due_at=null
        where published_at is not null`,
      );
      await stack.flushRedis();
      stack.worker.start();

      facts = await waitForRunsToEnd(
        stack,
        Object.values(runs),
        RECOVERY_LIMIT_MS,
      );
    }, SCENARIO_LIMIT_MS);

    afterAll(async () => {
      await stack.close();
    }, SCENARIO_LIMIT_MS);

    const factsOf = (name: string): RunFacts => factsOfRun(facts, runs, name);

    it('advances a run whose advance job has no due time', () => {
      expect(factsOf('advance').status).toBe('succeeded');
      expect(stack.sink.calls('after-old-advance')).toHaveLength(1);
    });

    it('runs a step whose attempt job has no due time', () => {
      expect(factsOf('attempt').status).toBe('succeeded');
      expect(stack.sink.calls('old-attempt')).toHaveLength(1);
    });
  },
);

/**
 * Failure notifications wrote no receipt before due times arrived, so every one
 * ever published has the shape the upgrade scan looks for, delivered long ago or
 * not. Run retention takes the run and its intent with it and leaves the outbox
 * row. Its job can then only fail, so nothing may keep asking for it.
 */
describeFaults('an old alert job whose run was retained away', () => {
  let stack: Stack;
  let asked: number | undefined;
  let eventId: string | undefined;

  beforeAll(async () => {
    stack = await startStack('old-alert', { slackFromSink: true });
    const workspace = await stack.api.createWorkspace('recovery-old-alert');
    const slack = await stack.api.createSlackConnection(
      workspace,
      'xoxb-recovery-healthy-1',
    );
    const alerting = await stack.api.publish(
      workspace,
      'alerting',
      httpChain([failingStep(stack, 'old-alerting')]),
    );
    await stack.api.alertToSlack(workspace, alerting, slack, 'C0ALERTS');
    const run = await stack.api.startRun(workspace, alerting);
    await waitForRunsToEnd(stack, [run], RECOVERY_LIMIT_MS);
    const deadline = Date.now() + RECOVERY_LIMIT_MS;
    while (Date.now() < deadline) {
      const [intent] = await stack.sql<{ status: string }>(
        `select status from app.run_failure_notification_intents where workflow_run_id=$1`,
        [run],
      );
      if (intent?.status === 'delivered') break;
      await delay(250);
    }

    await stack.worker.stop('SIGKILL');
    // What the release before this one left behind, once retention had been by.
    [{ id: eventId }] = (await stack.sql<{ id: string }>(
      `select id from app.outbox_events
        where job_name='deliver-run-failure-notification'`,
    )) as [{ id: string }];
    await stack.sql(`delete from app.inbox_receipts where message_id=$1`, [
      eventId,
    ]);
    await stack.sql(
      `update app.outbox_events set delivery_due_at=null where id=$1`,
      [eventId],
    );
    await stack.sql(`delete from app.workflow_runs where id=$1`, [run]);

    stack.worker.start();
    await delay(FIRST_ASKING_MS);
    // A row still being watched is asked for again when its time comes; bring that
    // forward rather than wait for it.
    await stack.sql(
      `update app.outbox_events set delivery_due_at=clock_timestamp()
        where id=$1 and delivery_due_at is not null`,
      [eventId],
    );
    await delay(SCAN_MS);
    asked = (
      await stack.sql<{ redeliveries: number }>(
        `select redeliveries from app.outbox_events where id=$1`,
        [eventId],
      )
    )[0]?.redeliveries;
  }, SCENARIO_LIMIT_MS);

  afterAll(async () => {
    await stack.close();
  }, SCENARIO_LIMIT_MS);

  it('really has the old row to read', () => {
    expect(asked).toBeTypeOf('number');
  });

  it('stops asking for a job that has nothing left to do', () => {
    expect(asked).toBeLessThanOrEqual(1);
  });
});
