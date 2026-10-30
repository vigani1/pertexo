import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  describeFaults,
  RECOVERY_LIMIT_MS,
  SCENARIO_LIMIT_MS,
} from '../support/recovery/environment.js';
import {
  delay,
  waitForRunsToEnd,
  type RunFacts,
} from '../support/recovery/facts.js';
import { nextStep, slowStep, startFlow } from '../support/recovery/flows.js';
import { redisCommand } from '../support/recovery/services.js';
import { startStack, type Stack } from '../support/recovery/stack.js';

const DISPATCH_LIMIT_MS = 30_000;
// Long enough to use up the old budget of 10 publish attempts in about 16 s.
const REFUSING_WRITES_MS = 22_000;
const NORMAL_MAXMEMORY = '256mb';

// The Redis a full `noeviction` limit or AOF disk produces: up, answering, refusing writes.
describeFaults('Redis refusing writes while a step finishes', () => {
  let stack: Stack;
  let runId: string;
  let facts: Readonly<Record<string, RunFacts>>;
  let failedEvents: number;

  const setMaxMemory = async (value: string): Promise<void> => {
    await redisCommand(
      stack.redisDatabase,
      'CONFIG',
      'SET',
      'maxmemory',
      value,
    );
  };

  beforeAll(async () => {
    stack = await startStack('redis-refuses-writes');
    const workspace = await stack.api.createWorkspace('recovery-redis-oom');
    runId = await startFlow(stack, workspace, 'oom', [
      slowStep(stack, 'oom', 'POST', 3),
      nextStep(stack, 'after-oom'),
    ]);
    await stack.sink.waitForCalls('oom', 1, DISPATCH_LIMIT_MS);

    await setMaxMemory('1mb');
    await delay(REFUSING_WRITES_MS);
    await setMaxMemory(NORMAL_MAXMEMORY);

    facts = await waitForRunsToEnd(stack, [runId], RECOVERY_LIMIT_MS);
    const [failed] = await stack.sql<{ count: number }>(
      `select count(*)::int as count from app.outbox_events where failed_at is not null`,
    );
    failedEvents = failed?.count ?? 0;
  }, SCENARIO_LIMIT_MS);

  afterAll(async () => {
    await setMaxMemory(NORMAL_MAXMEMORY);
    await stack.close();
  }, SCENARIO_LIMIT_MS);

  // backend-gaps-01, reliability-08: a refused write counts against a final budget.
  it.fails('fails no outbox event permanently', () => {
    expect(failedEvents).toBe(0);
  });

  // backend-gaps-01, ops-03: the run has no way forward once its event has failed.
  it.fails('finishes the run once Redis accepts writes again', () => {
    expect(facts[runId]?.status).toBe('succeeded');
    expect(stack.sink.calls('after-oom')).toHaveLength(1);
  });

  it('never sends the step twice', () => {
    expect(stack.sink.calls('oom')).toHaveLength(1);
  });

  it('keeps the same worker process, since readiness sees a healthy Redis', () => {
    expect(stack.worker.exits).toEqual([]);
  });
});
