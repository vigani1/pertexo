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
import {
  heldStep,
  nextStep,
  slowStep,
  startFlow,
} from '../support/recovery/flows.js';
import type {
  ExitRecord,
  ServiceProcess,
} from '../support/recovery/processes.js';
import { startStack, type Stack } from '../support/recovery/stack.js';

const DISPATCH_LIMIT_MS = 30_000;
// Past the 30 s lease and a scan.
const FROZEN_MS = 40_000;
const THAW_SETTLE_MS = 20_000;

/**
 * An event loop that stops turning: a host out of CPU, a long collection, a VM
 * paused. Such a worker now only warns and is not restarted, so this is what stands
 * between it and a duplicate. It keeps its sockets and wakes up believing it still
 * owns steps that a second worker has settled in the meantime.
 */
describeFaults('a worker frozen past its leases, then thawed', () => {
  let stack: Stack;
  let second: ServiceProcess;
  let facts: Readonly<Record<string, RunFacts>>;
  let exits: readonly ExitRecord[];
  let active: number;
  const runs: Record<string, string> = {};

  beforeAll(async () => {
    stack = await startStack('frozen-worker');
    const workspace = await stack.api.createWorkspace('recovery-frozen');
    runs.unsafe = await startFlow(stack, workspace, 'unsafe', [
      heldStep(stack, 'frozen-unsafe', 'POST'),
      nextStep(stack, 'after-frozen-unsafe'),
    ]);
    runs.safe = await startFlow(stack, workspace, 'safe', [
      heldStep(stack, 'frozen-safe', 'GET'),
      nextStep(stack, 'after-frozen-safe'),
    ]);
    runs.answered = await startFlow(stack, workspace, 'answered', [
      slowStep(stack, 'frozen-answered', 'POST', 5),
      nextStep(stack, 'after-frozen-answered'),
    ]);
    for (const id of ['frozen-unsafe', 'frozen-safe', 'frozen-answered'])
      await stack.sink.waitForCalls(id, 1, DISPATCH_LIMIT_MS);

    second = stack.createWorker('recovery-worker-second');
    second.start();
    await second.waitForLog(/worker\.started/u, DISPATCH_LIMIT_MS * 4);

    stack.worker.signal('SIGSTOP');
    await delay(FROZEN_MS);
    stack.worker.signal('SIGCONT');

    facts = await waitForRunsToEnd(
      stack,
      Object.values(runs),
      RECOVERY_LIMIT_MS,
    );
    // The thawed worker's late heartbeats and completions land in this time.
    await delay(THAW_SETTLE_MS);
    exits = [...stack.worker.exits];
    active = await activeRuns(stack, workspace);
  }, SCENARIO_LIMIT_MS);

  afterAll(async () => {
    await stack.close();
  }, SCENARIO_LIMIT_MS);

  const factsOf = (name: string): RunFacts => factsOfRun(facts, runs, name);

  it('settles an unsafe step truthfully, and never sends it again', () => {
    expect(factsOf('unsafe').status).toBe('outcome_unknown');
    expect(stack.sink.calls('frozen-unsafe')).toHaveLength(1);
    expect(stack.sink.calls('after-frozen-unsafe')).toHaveLength(0);
  });

  it('repeats a safe step once, without the frozen worker', () => {
    expect(factsOf('safe').status).toBe('succeeded');
    expect(stack.sink.calls('frozen-safe')).toHaveLength(2);
    expect(stack.sink.calls('after-frozen-safe')).toHaveLength(1);
  });

  // The provider answered while the worker was frozen. Whichever way this ends, it
  // ends once: the step is not sent again and the run never moves on twice.
  it('ends a step that finished during the freeze, once', () => {
    const { status } = factsOf('answered');
    expect(stack.sink.calls('frozen-answered')).toHaveLength(1);
    expect(stack.sink.calls('after-frozen-answered')).toHaveLength(
      status === 'succeeded' ? 1 : 0,
    );
    expect(['succeeded', 'outcome_unknown']).toContain(status);
  });

  it('keeps the thawed worker running', () => {
    expect(exits).toEqual([]);
    expect(stack.worker.alive).toBe(true);
    expect(
      stack.worker.linesMentioning(['worker.resource_unhealthy_drain'], 'warn'),
    ).toHaveLength(0);
  });

  // reliability-code-01: a warning is now the only thing a stall leaves behind, and it
  // reads p99. One 40 s gap among a window's samples is never the 99th percentile.
  it.fails('says that it stalled', () => {
    expect(
      stack.worker.linesMentioning(['worker.event_loop_delayed'], 'warn'),
    ).not.toHaveLength(0);
  });

  it('leaves no capacity held', () => {
    expect(active).toBe(0);
  });
});
