import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  describeFaults,
  RECOVERY_LIMIT_MS,
  SCENARIO_LIMIT_MS,
} from '../support/recovery/environment.js';
import {
  activeRuns,
  delay,
  factsOfRun,
  waitForRunsToEnd,
  type RunFacts,
} from '../support/recovery/facts.js';
import { nextStep, slowStep, startFlow } from '../support/recovery/flows.js';
import { startService, stopService } from '../support/recovery/services.js';
import { startStack, type Stack } from '../support/recovery/stack.js';

const DISPATCH_LIMIT_MS = 30_000;
// Longer than the worker's 10 s readiness interval, so a check always lands inside it.
const POSTGRES_DOWN_MS = 12_000;

const SAFE_RUNS = [
  ['safe-early', 2],
  ['safe-during', 5],
] as const;
const UNSAFE_RUNS = [
  ['unsafe-during', 4],
  ['unsafe-after', 25],
  ['unsafe-later', 40],
] as const;

describeFaults('a short Postgres stop during running steps', () => {
  let stack: Stack;
  let workspace: string;
  let facts: Readonly<Record<string, RunFacts>>;
  let active: number;
  const runs: Record<string, string> = {};

  beforeAll(async () => {
    stack = await startStack('postgres-restart');
    workspace = await stack.api.createWorkspace('recovery-postgres');
    for (const [id, seconds] of SAFE_RUNS)
      runs[id] = await startFlow(stack, workspace, id, [
        slowStep(stack, id, 'GET', seconds),
        nextStep(stack, `after-${id}`),
      ]);
    for (const [id, seconds] of UNSAFE_RUNS)
      runs[id] = await startFlow(stack, workspace, id, [
        slowStep(stack, id, 'POST', seconds),
        nextStep(stack, `after-${id}`),
      ]);
    for (const [id] of [...SAFE_RUNS, ...UNSAFE_RUNS])
      await stack.sink.waitForCalls(id, 1, DISPATCH_LIMIT_MS);

    await stopService('postgres');
    await delay(POSTGRES_DOWN_MS);
    await startService('postgres');

    facts = await waitForRunsToEnd(
      stack,
      Object.values(runs),
      RECOVERY_LIMIT_MS,
    );
    active = await activeRuns(stack, workspace);
  }, SCENARIO_LIMIT_MS);

  afterAll(async () => {
    await stack.close();
  }, SCENARIO_LIMIT_MS);

  const factsOf = (name: string): RunFacts => factsOfRun(facts, runs, name);

  // reliability-04: coordinator jobs burn 3 retries at 1 s, then nobody retries.
  it.fails(
    'finishes every run whose steps could be repeated or recorded',
    () => {
      expect(factsOf('safe-early').status).toBe('succeeded');
      expect(factsOf('safe-during').status).toBe('succeeded');
      expect(factsOf('unsafe-after').status).toBe('succeeded');
      expect(factsOf('unsafe-later').status).toBe('succeeded');
    },
  );

  // reliability-04: a step that ended during the stop must still reach an end.
  it.fails(
    'ends the run of an unsafe step that finished during the stop',
    () => {
      expect(['succeeded', 'outcome_unknown']).toContain(
        factsOf('unsafe-during').status,
      );
    },
  );

  // reliability-03: a stranded run keeps its slot.
  it.fails('releases every slot', () => {
    expect(active).toBe(0);
  });

  it('never sends an unsafe step twice', () => {
    for (const [id] of UNSAFE_RUNS) {
      expect(stack.sink.calls(id)).toHaveLength(1);
      expect(stack.sink.calls(`after-${id}`).length).toBeLessThanOrEqual(1);
    }
  });

  // reliability-07: one failed readiness check sends the worker SIGTERM.
  it.fails('keeps the same worker process through the stop', () => {
    expect(stack.worker.exits).toEqual([]);
    expect(stack.worker.starts).toHaveLength(1);
  });
});
