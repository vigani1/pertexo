import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  describeFaults,
  RECOVERY_LIMIT_MS,
  SCENARIO_LIMIT_MS,
} from '../support/recovery/environment.js';
import {
  delay,
  required,
  runFacts,
  waitForRunsToEnd,
  type RunFacts,
} from '../support/recovery/facts.js';
import { nextStep, slowStep, startFlow } from '../support/recovery/flows.js';
import { startService, stopService } from '../support/recovery/services.js';
import { startStack, type Stack } from '../support/recovery/stack.js';

const DISPATCH_LIMIT_MS = 30_000;
const REDIS_DOWN_MS = 13_000;
// With Redis back, dispatching should resume in moments, not after a 60 s drain.
const RESUME_LIMIT_MS = 30_000;
// The worker used to exit about 75 s into a blip like this one.
const WATCH_WORKER_MS = 90_000;

describeFaults('a short Redis stop during a step', () => {
  let stack: Stack;
  let runId: string;
  let afterResume: RunFacts;
  let final: Readonly<Record<string, RunFacts>>;
  let failedEvents: number;

  beforeAll(async () => {
    stack = await startStack('redis-blip');
    const workspace = await stack.api.createWorkspace('recovery-redis-blip');
    runId = await startFlow(stack, workspace, 'blip', [
      slowStep(stack, 'blip', 'POST', 6),
      nextStep(stack, 'after-blip'),
    ]);
    await stack.sink.waitForCalls('blip', 1, DISPATCH_LIMIT_MS);

    const stoppedAt = Date.now();
    await stopService('redis');
    await delay(REDIS_DOWN_MS);
    await startService('redis');

    const resumed = await waitForRunsToEnd(stack, [runId], RESUME_LIMIT_MS);
    afterResume = required(resumed[runId], 'run');
    await delay(Math.max(0, stoppedAt + WATCH_WORKER_MS - Date.now()));

    final = await waitForRunsToEnd(stack, [runId], RECOVERY_LIMIT_MS);
    const [failed] = await stack.sql<{ count: number }>(
      `select count(*)::int as count from app.outbox_events where failed_at is not null`,
    );
    failedEvents = failed?.count ?? 0;
  }, SCENARIO_LIMIT_MS);

  afterAll(async () => {
    await stack.close();
  }, SCENARIO_LIMIT_MS);

  // reliability-07: a 13 s blip costs about 75 s with no dispatching.
  it.fails('resumes dispatching moments after Redis returns', () => {
    expect(afterResume.status).toBe('succeeded');
  });

  // reliability-07, RT-01: the worker exits on a failed readiness check.
  it.fails('keeps the same worker process through the blip', () => {
    expect(stack.worker.exits).toEqual([]);
    expect(stack.worker.starts).toHaveLength(1);
  });

  it('finishes the run, sending each step once', async () => {
    expect(final[runId]?.status).toBe('succeeded');
    expect((await runFacts(stack, runId)).status).toBe('succeeded');
    expect(stack.sink.calls('blip')).toHaveLength(1);
    expect(stack.sink.calls('after-blip')).toHaveLength(1);
  });

  it('fails no outbox event permanently', () => {
    expect(failedEvents).toBe(0);
  });
});
