import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  describeFaults,
  RECOVERY_LIMIT_MS,
  SCENARIO_LIMIT_MS,
} from '../support/recovery/environment.js';
import {
  delay,
  factsOfRun,
  waitForRunsToEnd,
  type RunFacts,
} from '../support/recovery/facts.js';
import { nextStep, slowStep, startFlow } from '../support/recovery/flows.js';
import { waitThen } from '../support/recovery/graphs.js';
import { startStack, type Stack } from '../support/recovery/stack.js';

const DISPATCH_LIMIT_MS = 30_000;
// Past the 60 s a delivery has to be confirmed, so its due time passes mid-step.
const STEP_SECONDS = 75;
const READ_INTERVAL_MS = 500;

// With nothing wrong, recovery has to stay out of the way of whatever takes time:
// a long step, a run waiting for capacity, and a run sitting in a timed Wait.
describeFaults('healthy runs that outlast the delivery time', () => {
  let stack: Stack;
  let facts: Readonly<Record<string, RunFacts>>;
  const runs: Record<string, string> = {};
  const stalledReads: Record<string, unknown>[] = [];

  beforeAll(async () => {
    stack = await startStack('long-step');
    const workspace = await stack.api.createWorkspace('recovery-long-step');
    const quiet = await stack.api.createWorkspace('recovery-wait');
    runs.long = await startFlow(stack, workspace, 'long', [
      slowStep(stack, 'long', 'POST', STEP_SECONDS),
      nextStep(stack, 'after-long'),
    ]);
    runs.wait = await startFlow(
      stack,
      quiet,
      'wait',
      waitThen(STEP_SECONDS, nextStep(stack, 'after-wait')),
    );
    await stack.sink.waitForCalls('long', 1, DISPATCH_LIMIT_MS);
    // A workspace runs five at a time: these hold the slots, so the last one queues.
    for (const index of [1, 2, 3, 4]) {
      const name = `holder-${String(index)}`;
      runs[name] = await startFlow(stack, workspace, name, [
        slowStep(stack, name, 'POST', STEP_SECONDS),
      ]);
      await stack.sink.waitForCalls(name, 1, DISPATCH_LIMIT_MS);
    }
    runs.queued = await startFlow(stack, workspace, 'queued', [
      nextStep(stack, 'queued'),
    ]);

    const until = Date.now() + (STEP_SECONDS - 5) * 1_000;
    while (Date.now() < until) {
      for (const [name, space] of [
        ['long', workspace],
        ['queued', workspace],
        ['wait', quiet],
      ] as const) {
        const read = await stack.api.readRun(space, runs[name] ?? '');
        if (read.stalled !== undefined && read.stalled !== null)
          stalledReads.push({ name, stalled: read.stalled });
      }
      await delay(READ_INTERVAL_MS);
    }
    facts = await waitForRunsToEnd(
      stack,
      Object.values(runs),
      RECOVERY_LIMIT_MS,
    );
  }, SCENARIO_LIMIT_MS);

  afterAll(async () => {
    await stack.close();
  }, SCENARIO_LIMIT_MS);

  it('never says any of them has stalled', () => {
    expect(stalledReads).toEqual([]);
  });

  it('finishes the long step, with one attempt and one provider call', () => {
    const long = factsOfRun(facts, runs, 'long');
    expect(long.status).toBe('succeeded');
    expect(long.steps.slow).toEqual(['succeeded']);
    expect(stack.sink.calls('long')).toHaveLength(1);
    expect(stack.sink.calls('after-long')).toHaveLength(1);
  });

  it('runs the queued run once its turn comes, once', () => {
    expect(factsOfRun(facts, runs, 'queued').status).toBe('succeeded');
    expect(stack.sink.calls('queued')).toHaveLength(1);
  });

  it('finishes the Wait, once', () => {
    expect(factsOfRun(facts, runs, 'wait').status).toBe('succeeded');
    expect(stack.sink.calls('after-wait')).toHaveLength(1);
  });
});
