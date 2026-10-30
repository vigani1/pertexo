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
  required,
  waitForRunsToEnd,
  type RunFacts,
} from '../support/recovery/facts.js';
import { heldStep, nextStep, startFlow } from '../support/recovery/flows.js';
import { httpChain } from '../support/recovery/graphs.js';
import { startStack, type Stack } from '../support/recovery/stack.js';

// Past the 30 s attempt lease, so every lease has expired before a worker returns.
const WORKER_DOWN_MS = 40_000;
const DISPATCH_LIMIT_MS = 30_000;

type Scenario = Readonly<{
  activeInFullWorkspace: number;
  activeInMixedWorkspace: number;
  cancelStatus: number;
  facts: Readonly<Record<string, RunFacts>>;
  runs: Readonly<Record<string, string>>;
  stuckList: string;
  stalledRead: Record<string, unknown>;
  healthyRead: Record<string, unknown>;
}>;

describeFaults('a worker killed with SIGKILL during its steps', () => {
  let stack: Stack;
  let scenario: Scenario;

  const calls = (id: string): number => stack.sink.calls(id).length;

  beforeAll(async () => {
    stack = await startStack('worker-killed');
    const { api, sink } = stack;
    const mixed = await api.createWorkspace('recovery-mixed');
    const full = await api.createWorkspace('recovery-full');

    const runs: Record<string, string> = {
      unsafe: await startFlow(stack, mixed, 'unsafe', [
        heldStep(stack, 'unsafe', 'POST'),
        nextStep(stack, 'after-unsafe'),
      ]),
      // A GET only reads, so a repeat can't cause a side effect.
      safe: await startFlow(stack, mixed, 'safe', [
        heldStep(stack, 'safe', 'GET'),
        nextStep(stack, 'after-safe'),
      ]),
      canceled: await startFlow(stack, mixed, 'canceled', [
        heldStep(stack, 'canceled', 'GET'),
        nextStep(stack, 'after-canceled'),
      ]),
      deadline: await startFlow(
        stack,
        mixed,
        'deadline',
        httpChain(
          [
            heldStep(stack, 'deadline', 'GET'),
            nextStep(stack, 'after-deadline'),
          ],
          { maxRunDurationMs: 25_000 },
        ),
      ),
      undispatched: await startFlow(stack, mixed, 'undispatched', [
        heldStep(stack, 'undispatched', 'POST'),
      ]),
    };
    for (const index of [1, 2, 3, 4, 5])
      runs[`full${String(index)}`] = await startFlow(
        stack,
        full,
        `full-${String(index)}`,
        [heldStep(stack, `full${String(index)}`, 'POST')],
      );
    runs.queued = await startFlow(stack, full, 'queued', [
      nextStep(stack, 'queued'),
    ]);

    for (const id of [
      'unsafe',
      'safe',
      'canceled',
      'deadline',
      'undispatched',
      'full1',
      'full2',
      'full3',
      'full4',
      'full5',
    ])
      await sink.waitForCalls(id, 1, DISPATCH_LIMIT_MS);

    const undispatchedRun = required(runs.undispatched, 'undispatched');
    const healthyRead = await api.readRun(mixed, undispatchedRun);

    await stack.worker.stop('SIGKILL');

    // The crash window before a step reaches its provider: the same stored state
    // a worker leaves when it dies between its claim and its dispatch record.
    await stack.sql(
      `update app.node_attempts a set dispatch_marked_at=null
         from app.node_runs n
        where n.id=a.node_run_id and n.workspace_id=a.workspace_id
          and n.workflow_run_id=$1`,
      [undispatchedRun],
    );
    const cancel = await api.cancelRun(
      mixed,
      required(runs.canceled, 'canceled'),
    );

    await delay(WORKER_DOWN_MS);

    const stalledRead = await api.readRun(
      mixed,
      required(runs.unsafe, 'unsafe'),
    );
    const operator = stack.operator({
      OPERATOR_COMMAND_TYPE: 'stuck-work.list',
    });
    operator.startOnce();
    await delay(5_000);
    await operator.stop('SIGKILL');

    stack.worker.start();
    const facts = await waitForRunsToEnd(
      stack,
      Object.values(runs),
      RECOVERY_LIMIT_MS,
    );

    scenario = {
      activeInFullWorkspace: await activeRuns(stack, full),
      activeInMixedWorkspace: await activeRuns(stack, mixed),
      cancelStatus: cancel.status,
      facts,
      healthyRead,
      runs,
      stalledRead,
      stuckList: operator.logs.map(({ text }) => text).join('\n'),
    };
  }, SCENARIO_LIMIT_MS);

  afterAll(async () => {
    await stack.close();
  }, SCENARIO_LIMIT_MS);

  const factsOf = (name: string): RunFacts =>
    factsOfRun(scenario.facts, scenario.runs, name);

  // reliability-01, ops-03, backend-gaps-02: nothing acts on an expired lease.
  it.fails('ends an unsafe dispatched step as outcome_unknown', () => {
    expect(factsOf('unsafe').status).toBe('outcome_unknown');
    expect(factsOf('unsafe').steps.held).toEqual(['outcome_unknown']);
  });

  it('never sends an unsafe dispatched step twice, and runs no later step', () => {
    expect(calls('unsafe')).toBe(1);
    expect(calls('after-unsafe')).toBe(0);
  });

  // reliability-01: a safe step whose worker died is retried by a live worker.
  it.fails('retries a safe step and finishes the run', () => {
    expect(factsOf('safe').status).toBe('succeeded');
    expect(calls('safe')).toBe(2);
    expect(calls('after-safe')).toBe(1);
  });

  // reliability-01: an unsafe step that never reached its provider can safely run.
  it.fails('runs again an unsafe step that was never dispatched', () => {
    expect(factsOf('undispatched').status).toBe('succeeded');
  });

  it('accepts the cancel while no worker is alive', () => {
    expect(scenario.cancelStatus).toBe(200);
  });

  // reliability-06: cancel depends on a live worker holding the attempt.
  it.fails('honors the cancel with no live worker on the attempt', () => {
    expect(factsOf('canceled').status).toBe('canceled');
    expect(calls('after-canceled')).toBe(0);
  });

  // reliability-06: the deadline depends on a live worker holding the attempt.
  it.fails('ends a run past its deadline, without retrying the step', () => {
    expect(factsOf('deadline').status).toBe('timed_out');
    expect(calls('deadline')).toBe(1);
    expect(calls('after-deadline')).toBe(0);
  });

  // reliability-03: five stranded runs hold every slot of the workspace forever.
  it.fails('frees stranded capacity, so the waiting run executes', () => {
    expect(factsOf('queued').status).toBe('succeeded');
    expect(calls('queued')).toBe(1);
    for (const name of ['full1', 'full2', 'full3', 'full4', 'full5'])
      expect(factsOf(name).status).toBe('outcome_unknown');
  });

  // reliability-03: the capacity counter must come back to zero with every run ended.
  it.fails('leaves no capacity held once every run has ended', () => {
    expect(scenario.activeInFullWorkspace).toBe(0);
    expect(scenario.activeInMixedWorkspace).toBe(0);
  });

  // reliability-10: a stuck run reads as "Its steps are running right now".
  it.fails('tells the user a run is stalled once its worker is gone', () => {
    expect(scenario.healthyRead.stalled ?? null).toBeNull();
    expect(scenario.stalledRead.stalled).toEqual({
      since: expect.any(String) as string,
    });
  });

  // reliability-10: operators had to read the tables with psql to find stuck runs.
  it.fails('lists the stuck run for the operator', () => {
    expect(scenario.stuckList).toContain(scenario.runs.unsafe);
  });

  // reliability-10: recovery has to leave a trace an operator can read.
  it.fails('logs each recovery with the run it acted on', () => {
    expect(
      stack.worker.linesMentioning(
        [required(scenario.runs.unsafe, 'unsafe')],
        'info',
      ),
    ).not.toEqual([]);
  });
});
