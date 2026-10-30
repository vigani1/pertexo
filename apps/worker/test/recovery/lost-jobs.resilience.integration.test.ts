import { QUEUE_NAME } from '@pertexo/queue';
import { Queue } from 'bullmq';
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
import { httpChain } from '../support/recovery/graphs.js';
import { startStack, type Stack } from '../support/recovery/stack.js';

const DISPATCH_LIMIT_MS = 30_000;
const PUBLISH_LIMIT_MS = 30_000;

/** Redis's restore-from-nothing case: rebuilds hold no record of published jobs. */
describeFaults('jobs published to Redis, then lost', () => {
  let stack: Stack;
  let workspace: string;
  let facts: Readonly<Record<string, RunFacts>>;
  let cancelStatus: number;
  let active: number;
  const runs: Record<string, string> = {};

  const connection = () => {
    const parsed = new URL(stack.redisUrl);
    return {
      db: stack.redisDatabase,
      host: parsed.hostname,
      password: decodeURIComponent(parsed.password),
      port: Number(parsed.port),
    };
  };

  const pausedQueue = async (name: string): Promise<void> => {
    const queue = new Queue(name, { connection: connection() });
    try {
      await queue.waitUntilReady();
      await queue.pause();
    } finally {
      await queue.close();
    }
  };

  /** Waits until every outbox event of these runs has reached Redis. */
  const waitForPublished = async (
    runIds: readonly string[],
    minimumEvents: number,
  ): Promise<void> => {
    const deadline = Date.now() + PUBLISH_LIMIT_MS;
    for (;;) {
      const [row] = await stack.sql<{ total: number; waiting: number }>(
        `select count(*)::int as total,
                count(*) filter (where published_at is null)::int as waiting
           from app.outbox_events
          where aggregate_id = any($1::uuid[])`,
        [runIds],
      );
      if (row?.waiting === 0 && row.total >= minimumEvents) return;
      if (Date.now() > deadline)
        throw new Error(`Events never reached Redis: ${JSON.stringify(row)}`);
      await delay(100);
    }
  };

  const eventCount = async (runId: string): Promise<number> => {
    const [row] = await stack.sql<{ total: number }>(
      `select count(*)::int as total from app.outbox_events where aggregate_id=$1`,
      [runId],
    );
    return row?.total ?? 0;
  };

  beforeAll(async () => {
    stack = await startStack('lost-jobs');
    workspace = await stack.api.createWorkspace('recovery-lost-jobs');

    // A lost advance: the step finishes, its advance is published to a paused
    // queue, so no worker consumes it before Redis loses it.
    runs.advance = await startFlow(stack, workspace, 'advance', [
      slowStep(stack, 'advance', 'POST', 5),
      nextStep(stack, 'after-advance'),
    ]);
    await stack.sink.waitForCalls('advance', 1, DISPATCH_LIMIT_MS);
    const eventsBeforeStepEnds = await eventCount(runs.advance);
    await pausedQueue(QUEUE_NAME.workflowCoordinator);
    await waitForPublished([runs.advance], eventsBeforeStepEnds + 1);
    await stack.flushRedis();

    // Lost attempt jobs: each run's first step is `ready`, published to a paused queue.
    await pausedQueue(QUEUE_NAME.nodeAttempts);
    runs.attempt = await startFlow(stack, workspace, 'attempt', [
      nextStep(stack, 'lost-attempt'),
    ]);
    runs.canceled = await startFlow(stack, workspace, 'canceled', [
      nextStep(stack, 'lost-canceled'),
    ]);
    runs.deadline = await startFlow(
      stack,
      workspace,
      'deadline',
      httpChain([nextStep(stack, 'lost-deadline')], {
        maxRunDurationMs: 20_000,
      }),
    );
    const lost = [runs.attempt, runs.canceled, runs.deadline];
    const waiting = Date.now() + PUBLISH_LIMIT_MS;
    for (;;) {
      const [row] = await stack.sql<{ ready: number }>(
        `select count(*)::int as ready
           from app.node_attempts a
           join app.node_runs n on n.id=a.node_run_id and n.workspace_id=a.workspace_id
          where n.workflow_run_id = any($1::uuid[]) and a.status='ready'`,
        [lost],
      );
      if (row?.ready === 3) break;
      if (Date.now() > waiting)
        throw new Error(`Attempts never became ready: ${JSON.stringify(row)}`);
      await delay(100);
    }
    await waitForPublished(lost, 2);
    await stack.flushRedis();

    const cancel = await stack.api.cancelRun(workspace, runs.canceled);
    cancelStatus = cancel.status;

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

  // reliability-04, reliability-05: the row is `published`, so nothing sends it again.
  it.fails('advances a run whose advance job was lost', () => {
    expect(factsOf('advance').status).toBe('succeeded');
    expect(stack.sink.calls('advance')).toHaveLength(1);
    expect(stack.sink.calls('after-advance')).toHaveLength(1);
  });

  // reliability-05: `ready` forever, and `due-work.resume` answers `not_due`.
  it.fails('runs a step whose attempt job was lost', () => {
    expect(factsOf('attempt').status).toBe('succeeded');
    expect(stack.sink.calls('lost-attempt')).toHaveLength(1);
  });

  it('accepts a cancel for a run whose job was lost', () => {
    expect(cancelStatus).toBe(200);
  });

  // reliability-05, reliability-06: a cancel is accepted and has no effect.
  it.fails('honors the cancel without running the step', () => {
    expect(factsOf('canceled').status).toBe('canceled');
    expect(stack.sink.calls('lost-canceled')).toHaveLength(0);
  });

  // reliability-05, reliability-06: the deadline wake-up can't end a `ready` attempt.
  it.fails('ends a run past its deadline without running the step', () => {
    expect(factsOf('deadline').status).toBe('timed_out');
    expect(stack.sink.calls('lost-deadline')).toHaveLength(0);
  });

  // reliability-03: every lost job would otherwise keep its slot forever.
  it.fails('releases every slot', () => {
    expect(active).toBe(0);
  });
});
