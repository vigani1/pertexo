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
import { startStack, type Stack } from '../support/recovery/stack.js';

const DISPATCH_LIMIT_MS = 30_000;
// Past the 60 s a delivery has to be confirmed, so its due time passes mid-step.
const STEP_SECONDS = 75;
const READ_INTERVAL_MS = 500;

// With nothing wrong, recovery has to stay out of the way of a long step.
describeFaults('a healthy step that outlasts its delivery time', () => {
  let stack: Stack;
  let facts: Readonly<Record<string, RunFacts>>;
  const runs: Record<string, string> = {};
  const stalledReads: unknown[] = [];

  beforeAll(async () => {
    stack = await startStack('long-step');
    const workspace = await stack.api.createWorkspace('recovery-long-step');
    runs.long = await startFlow(stack, workspace, 'long', [
      slowStep(stack, 'long', 'POST', STEP_SECONDS),
      nextStep(stack, 'after-long'),
    ]);
    await stack.sink.waitForCalls('long', 1, DISPATCH_LIMIT_MS);

    const until = Date.now() + (STEP_SECONDS - 5) * 1_000;
    while (Date.now() < until) {
      const read = await stack.api.readRun(workspace, runs.long);
      if (read.stalled !== undefined) stalledReads.push(read.stalled);
      await delay(READ_INTERVAL_MS);
    }
    facts = await waitForRunsToEnd(stack, [runs.long], RECOVERY_LIMIT_MS);
  }, SCENARIO_LIMIT_MS);

  afterAll(async () => {
    await stack.close();
  }, SCENARIO_LIMIT_MS);

  it('never says the run has stalled', () => {
    expect(stalledReads).toEqual([]);
  });

  it('finishes the run, with one attempt and one provider call', () => {
    const long = factsOfRun(facts, runs, 'long');
    expect(long.status).toBe('succeeded');
    expect(long.steps.slow).toEqual(['succeeded']);
    expect(stack.sink.calls('long')).toHaveLength(1);
    expect(stack.sink.calls('after-long')).toHaveLength(1);
  });
});
