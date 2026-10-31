import { afterAll, beforeAll, expect, it } from 'vitest';

import { productionService } from '../support/recovery/compose-config.js';
import {
  describeFaults,
  RECOVERY_LIMIT_MS,
  SCENARIO_LIMIT_MS,
} from '../support/recovery/environment.js';
import {
  factsOfRun,
  waitForRunsToEnd,
  type RunFacts,
} from '../support/recovery/facts.js';
import {
  heldStep,
  nextStep,
  slowStep,
  startFlow,
} from '../support/recovery/flows.js';
import { startStack, type Stack } from '../support/recovery/stack.js';

const DISPATCH_LIMIT_MS = 30_000;
// Room to flush logs and close connections before Docker's SIGKILL.
const CLOSING_MARGIN_MS = 5_000;

// A deploy or nightly backup: SIGTERM with a step running longer than the drain.
describeFaults('a worker stopped with SIGTERM during a step over 60 s', () => {
  let stack: Stack;
  let exitAfterMs: number;
  let facts: Readonly<Record<string, RunFacts>>;
  const runs: Record<string, string> = {};

  beforeAll(async () => {
    stack = await startStack('worker-sigterm');
    const workspace = await stack.api.createWorkspace('recovery-sigterm');
    runs.short = await startFlow(stack, workspace, 'short', [
      slowStep(stack, 'short', 'POST', 20),
      nextStep(stack, 'after-short'),
    ]);
    runs.unsafe = await startFlow(stack, workspace, 'unsafe', [
      slowStep(stack, 'unsafe', 'POST', 90),
      nextStep(stack, 'after-unsafe'),
    ]);
    runs.safe = await startFlow(stack, workspace, 'safe', [
      heldStep(stack, 'safe', 'GET'),
      nextStep(stack, 'after-safe'),
    ]);
    for (const id of ['short', 'unsafe', 'safe'])
      await stack.sink.waitForCalls(id, 1, DISPATCH_LIMIT_MS);

    const signaledAt = Date.now();
    const exit = await stack.worker.stop('SIGTERM');
    exitAfterMs = (exit?.at ?? Date.now()) - signaledAt;

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

  it('lets a step that fits the drain finish and continues its run', () => {
    expect(factsOf('short').status).toBe('succeeded');
    expect(stack.sink.calls('short')).toHaveLength(1);
    expect(stack.sink.calls('after-short')).toHaveLength(1);
  });

  // reliability-02: the job is recorded completed and the run stays running.
  it('ends an unsafe step cut off by the drain as outcome_unknown', () => {
    expect(factsOf('unsafe').status).toBe('outcome_unknown');
    expect(factsOf('unsafe').steps.slow).toEqual(['outcome_unknown']);
  });

  it('never sends an unsafe step cut off by the drain twice', () => {
    expect(stack.sink.calls('unsafe')).toHaveLength(1);
    expect(stack.sink.calls('after-unsafe')).toHaveLength(0);
  });

  // reliability-02: the same stranding happens to a step that could simply retry.
  it('retries a safe step cut off by the drain', () => {
    expect(factsOf('safe').status).toBe('succeeded');
    expect(stack.sink.calls('safe')).toHaveLength(2);
    expect(stack.sink.calls('after-safe')).toHaveLength(1);
  });

  // reliability-02: the drain equals the grace period, so no margin is left before SIGKILL.
  it('exits inside the production grace period, with room to close', async () => {
    const worker = await productionService('worker');
    expect(exitAfterMs + CLOSING_MARGIN_MS).toBeLessThan(
      worker.stopGracePeriodMs,
    );
  });
});
