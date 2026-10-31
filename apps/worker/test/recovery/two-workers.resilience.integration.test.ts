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
  releasedStep,
  startFlow,
} from '../support/recovery/flows.js';
import type { ServiceProcess } from '../support/recovery/processes.js';
import { startStack, type Stack } from '../support/recovery/stack.js';

const DISPATCH_LIMIT_MS = 30_000;
// Past the 30 s lease, so both workers find the same expired attempts at once.
const WORKER_DOWN_MS = 35_000;
// One row is settled before the other scanner reaches it. Several keep both busy
// on the same list, which is what makes them meet.
const RUNS_OF_EACH_KIND = 5;
// Short beside the 5 s a scan's lock wait can last, in case it is slow to start.
const POLL_MS = 100;
const START_LIMIT_MS = 120_000;
// A late scan finishes its old list, and a job it caused reaches the provider.
const LATE_SCAN_SETTLE_MS = 15_000;

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

/**
 * A scan reads its list once and walks it, so what it read can be old by the time
 * it reaches a row. The scenario above rarely shows that for a safe step: there the
 * second scanner is 50 to 200 ms behind the first, usually too soon for a new holder
 * to have called anyone, so a scanner that acted on its old read costs nothing the
 * provider can see. Here it comes back after the new holder has made its call, and
 * acting on what it read would send that step a third time.
 */
describeFaults(
  'a scanner that wakes up after a new holder made its call',
  () => {
    let stack: Stack;
    let late: ServiceProcess;
    let prompt: ServiceProcess;
    let nothingRecoveredYet: boolean;
    let callsAfterLateScan: Readonly<Record<string, number>>;
    let facts: Readonly<Record<string, RunFacts>>;
    let active: number;
    const runs: Record<string, string> = {};
    const names = Array.from(
      { length: RUNS_OF_EACH_KIND },
      (_, index) => `late-${String(index)}`,
    );

    const waitingOnLocks = async (): Promise<number> =>
      (
        await stack.sql<{ count: number }>(
          `select count(*)::int as count from pg_stat_activity
          where datname=current_database() and wait_event_type='Lock'`,
        )
      )[0]?.count ?? 0;

    const waitUntil = async (
      what: string,
      condition: (waiting: number) => boolean,
    ): Promise<void> => {
      const deadline = Date.now() + START_LIMIT_MS;
      while (!condition(await waitingOnLocks())) {
        if (Date.now() > deadline) throw new Error(`Never saw ${what}`);
        await delay(POLL_MS);
      }
    };

    beforeAll(async () => {
      stack = await startStack('late-scanner');
      const workspace = await stack.api.createWorkspace('recovery-late');
      for (const name of names)
        runs[name] = await startFlow(stack, workspace, name, [
          releasedStep(stack, name, 'GET'),
          nextStep(stack, `after-${name}`),
        ]);
      for (const name of names)
        await stack.sink.waitForCalls(name, 1, DISPATCH_LIMIT_MS);

      await stack.worker.stop('SIGKILL');
      await delay(WORKER_DOWN_MS);

      // Every run is locked, so a scan stops at the first row of the list it has read.
      const locks = await stack.connect();
      await locks.query('begin');
      await locks.query(
        `select id from app.workflow_runs where id = any($1::uuid[]) for update`,
        [Object.values(runs)],
      );
      late = stack.createWorker('recovery-worker-late');
      late.start();
      // Frozen while still starting, its startup would fail when it woke, and a
      // restart reads a new list.
      await late.waitForLog(/worker\.started/u, START_LIMIT_MS);
      await waitUntil('a scan waiting on a run', (waiting) => waiting > 0);
      late.signal('SIGSTOP');
      // Its lock wait times out on its own, so it holds nothing while it sleeps.
      await waitUntil('the lock wait end', (waiting) => waiting === 0);
      await locks.query('commit');
      locks.release();
      nothingRecoveredYet = stack.sink.calls(names[0] ?? '').length === 1;

      prompt = stack.createWorker('recovery-worker-prompt');
      prompt.start();
      for (const name of names)
        await stack.sink.waitForCalls(name, 2, RECOVERY_LIMIT_MS);

      late.signal('SIGCONT');
      await delay(LATE_SCAN_SETTLE_MS);
      callsAfterLateScan = Object.fromEntries(
        names.map((name) => [name, stack.sink.calls(name).length]),
      );

      // Anything it caused is answered too, so a wrong ending shows as well.
      for (const name of names)
        for (const call of [2, 3, 4]) stack.sink.release(name, call);
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

    // A restart would read a new list, and then no scan here has an old one.
    it('really woke the same process, with what it read before anything was recovered', () => {
      expect(nothingRecoveredYet).toBe(true);
      expect(
        late.exits,
        late.logs
          .slice(-20)
          .map(({ text }) => text)
          .join('\n'),
      ).toEqual([]);
      expect(late.starts).toHaveLength(1);
    });

    it('leaves the holder alone: the provider sees no third call', () => {
      expect(callsAfterLateScan).toEqual(
        Object.fromEntries(names.map((name) => [name, 2])),
      );
    });

    it('ends each run once', () => {
      for (const name of names) {
        expect(factsOfRun(facts, runs, name).status).toBe('succeeded');
        expect(stack.sink.calls(`after-${name}`)).toHaveLength(1);
      }
    });

    it('leaves no capacity held after the late scan', () => {
      expect(active).toBe(0);
    });
  },
);
