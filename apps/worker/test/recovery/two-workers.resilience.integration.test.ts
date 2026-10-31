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

// A rolling deploy or a scaled install: two scanners race for the same rows.
describeFaults('two workers recovering the same stranded runs', () => {
  let stack: Stack;
  let workers: readonly ServiceProcess[];
  let facts: Readonly<Record<string, RunFacts>>;
  let unknownEvents: number;
  let active: number;
  const runs: Record<string, string> = {};

  beforeAll(async () => {
    stack = await startStack('two-workers');
    const workspace = await stack.api.createWorkspace('recovery-two-workers');
    runs.unsafe = await startFlow(stack, workspace, 'unsafe', [
      heldStep(stack, 'unsafe', 'POST'),
      nextStep(stack, 'after-unsafe'),
    ]);
    runs.safe = await startFlow(stack, workspace, 'safe', [
      heldStep(stack, 'safe', 'GET'),
      nextStep(stack, 'after-safe'),
    ]);
    for (const id of ['unsafe', 'safe'])
      await stack.sink.waitForCalls(id, 1, DISPATCH_LIMIT_MS);

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
    const [row] = await stack.sql<{ count: number }>(
      `select count(*)::int as count from app.run_events
        where workflow_run_id=$1 and type='node.outcome_unknown'`,
      [runs.unsafe],
    );
    unknownEvents = row?.count ?? 0;
    active = await activeRuns(stack, workspace);
  }, SCENARIO_LIMIT_MS);

  afterAll(async () => {
    await stack.close();
  }, SCENARIO_LIMIT_MS);

  const factsOf = (name: string): RunFacts => factsOfRun(facts, runs, name);

  it('settles an unsafe step once, and never sends it again', () => {
    expect(factsOf('unsafe').status).toBe('outcome_unknown');
    expect(unknownEvents).toBe(1);
    expect(stack.sink.calls('unsafe')).toHaveLength(1);
    expect(stack.sink.calls('after-unsafe')).toHaveLength(0);
  });

  it('repeats a safe step exactly once', () => {
    expect(factsOf('safe').status).toBe('succeeded');
    expect(stack.sink.calls('safe')).toHaveLength(2);
    expect(stack.sink.calls('after-safe')).toHaveLength(1);
  });

  it('leaves no capacity held', () => {
    expect(active).toBe(0);
  });
});
