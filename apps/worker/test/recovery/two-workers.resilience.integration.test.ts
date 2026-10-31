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
import { heldStep, nextStep, startFlow } from '../support/recovery/flows.js';
import type { ServiceProcess } from '../support/recovery/processes.js';
import { startStack, type Stack } from '../support/recovery/stack.js';

const DISPATCH_LIMIT_MS = 30_000;
// Past the 30 s lease, so both workers find the same expired attempts at once.
const WORKER_DOWN_MS = 35_000;
// One row is settled before the other scanner reaches it. Several keep both busy
// on the same list, which is what makes them meet.
const RUNS_OF_EACH_KIND = 5;

// A rolling deploy or a scaled install: two scanners race for the same rows.
describeFaults('two workers recovering the same stranded runs', () => {
  let stack: Stack;
  let workers: readonly ServiceProcess[];
  let facts: Readonly<Record<string, RunFacts>>;
  let unknownEvents: Readonly<Record<string, number>>;
  let active: number;
  const runs: Record<string, string> = {};
  const names = (kind: string): readonly string[] =>
    Array.from(
      { length: RUNS_OF_EACH_KIND },
      (_, index) => `${kind}-${String(index)}`,
    );

  beforeAll(async () => {
    stack = await startStack('two-workers');
    // A workspace runs five at a time, so each kind gets its own.
    const unsafeWorkspace = await stack.api.createWorkspace('recovery-unsafe');
    const safeWorkspace = await stack.api.createWorkspace('recovery-safe');
    for (const name of names('unsafe'))
      runs[name] = await startFlow(stack, unsafeWorkspace, name, [
        heldStep(stack, name, 'POST'),
        nextStep(stack, `after-${name}`),
      ]);
    for (const name of names('safe'))
      runs[name] = await startFlow(stack, safeWorkspace, name, [
        heldStep(stack, name, 'GET'),
        nextStep(stack, `after-${name}`),
      ]);
    for (const name of Object.keys(runs))
      await stack.sink.waitForCalls(name, 1, DISPATCH_LIMIT_MS);

    await stack.worker.stop('SIGKILL');
    await delay(WORKER_DOWN_MS);

    workers = [
      stack.createWorker('recovery-worker-a'),
      stack.createWorker('recovery-worker-b'),
    ];
    for (const worker of workers) worker.start();

    facts = await waitForRunsToEnd(
      stack,
      Object.values(runs),
      RECOVERY_LIMIT_MS,
    );
    const counted: Record<string, number> = {};
    for (const name of names('unsafe')) {
      const [row] = await stack.sql<{ count: number }>(
        `select count(*)::int as count from app.run_events
          where workflow_run_id=$1 and type='node.outcome_unknown'`,
        [runs[name]],
      );
      counted[name] = row?.count ?? 0;
    }
    unknownEvents = counted;
    active =
      (await activeRuns(stack, unsafeWorkspace)) +
      (await activeRuns(stack, safeWorkspace));
  }, SCENARIO_LIMIT_MS);

  afterAll(async () => {
    await stack.close();
  }, SCENARIO_LIMIT_MS);

  const factsOf = (name: string): RunFacts => factsOfRun(facts, runs, name);

  it('settles an unsafe step once, and never sends it again', () => {
    for (const name of names('unsafe')) {
      expect(factsOf(name).status).toBe('outcome_unknown');
      expect(unknownEvents[name]).toBe(1);
      expect(stack.sink.calls(name)).toHaveLength(1);
      expect(stack.sink.calls(`after-${name}`)).toHaveLength(0);
    }
  });

  it('repeats a safe step exactly once', () => {
    for (const name of names('safe')) {
      expect(factsOf(name).status).toBe('succeeded');
      expect(stack.sink.calls(name)).toHaveLength(2);
      expect(stack.sink.calls(`after-${name}`)).toHaveLength(1);
    }
  });

  it('leaves no capacity held', () => {
    expect(active).toBe(0);
  });
});
