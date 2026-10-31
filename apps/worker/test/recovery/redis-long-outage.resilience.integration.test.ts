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
import type { ServiceProcess } from '../support/recovery/processes.js';
import { startService, stopService } from '../support/recovery/services.js';
import { startStack, type Stack } from '../support/recovery/stack.js';

const DISPATCH_LIMIT_MS = 30_000;
const REDIS_DOWN_MS = 150_000;
const STATE_SETTLE_MS = 40_000;

describeFaults('a long Redis outage', () => {
  let stack: Stack;
  let runId: string;
  let bootedInOutage: ServiceProcess;
  let bootOutcome: Readonly<{ exited: boolean; started: boolean }>;
  let facts: Readonly<Record<string, RunFacts>>;

  beforeAll(async () => {
    stack = await startStack('redis-long-outage');
    const workspace = await stack.api.createWorkspace('recovery-redis-long');
    runId = await startFlow(stack, workspace, 'long', [
      slowStep(stack, 'long', 'POST', 6),
      nextStep(stack, 'after-long'),
    ]);
    await stack.sink.waitForCalls('long', 1, DISPATCH_LIMIT_MS);

    await stopService('redis');
    // A worker that boots while Redis is gone, with nothing restarting it:
    // what compose sees is either a working worker or an exit it can restart.
    bootedInOutage = stack.createWorker('recovery-booted-in-outage');
    bootedInOutage.startOnce();
    await delay(REDIS_DOWN_MS);
    await startService('redis');

    facts = await waitForRunsToEnd(stack, [runId], RECOVERY_LIMIT_MS);
    await delay(STATE_SETTLE_MS);
    bootOutcome = {
      exited: bootedInOutage.exits.length > 0,
      started:
        bootedInOutage.linesMentioning(['worker.started'], 'info').length > 0,
    };
  }, SCENARIO_LIMIT_MS);

  afterAll(async () => {
    await stack.close();
  }, SCENARIO_LIMIT_MS);

  // RT-01: boot fails, the process only sets exitCode, and leaked timers keep it alive.
  it('never leaves a worker that neither works nor exits', () => {
    expect(bootOutcome.exited || bootOutcome.started).toBe(true);
  });

  // RT-01, reliability-05: the hung worker holds no connections and dispatches nothing.
  it('finishes the run once Redis returns', () => {
    expect(facts[runId]?.status).toBe('succeeded');
  });

  it('never sends the step twice', () => {
    expect(stack.sink.calls('long')).toHaveLength(1);
    expect(stack.sink.calls('after-long').length).toBeLessThanOrEqual(1);
  });
});
