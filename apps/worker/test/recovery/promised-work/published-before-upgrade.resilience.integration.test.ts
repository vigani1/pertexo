import { QUEUE_NAME } from '@pertexo/queue';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  describeFaults,
  RECOVERY_LIMIT_MS,
  SCENARIO_LIMIT_MS,
} from '../../support/recovery/environment.js';
import {
  factsOfRun,
  waitForRunsToEnd,
  type RunFacts,
} from '../../support/recovery/facts.js';
import { nextStep, slowStep, startFlow } from '../../support/recovery/flows.js';
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
