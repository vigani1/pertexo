import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  describeFaults,
  SCENARIO_LIMIT_MS,
} from '../support/recovery/environment.js';
import {
  delay,
  waitForRunsToEnd,
  type RunFacts,
} from '../support/recovery/facts.js';
import { nextStep } from '../support/recovery/flows.js';
import { httpChain } from '../support/recovery/graphs.js';
import { startService, stopService } from '../support/recovery/services.js';
import { startStack, type Stack } from '../support/recovery/stack.js';

// Longer than three 10 s readiness intervals, so a failed check has time to act.
const WATCH_WORKER_MS = 35_000;
const RUN_LIMIT_MS = 30_000;

describeFaults('an object store outage, for a workflow with no files', () => {
  let stack: Stack;
  let runId: string;
  let facts: Readonly<Record<string, RunFacts>>;
  let exitsDuringOutage: number;

  beforeAll(async () => {
    stack = await startStack('artifact-store-outage');
    const workspace = await stack.api.createWorkspace('recovery-no-files');
    const workflowId = await stack.api.publish(
      workspace,
      'no-files',
      httpChain([
        nextStep(stack, 'no-files-one'),
        { ...nextStep(stack, 'no-files-two'), id: 'second' },
      ]),
    );

    await stopService('artifact-store');
    await delay(WATCH_WORKER_MS);
    exitsDuringOutage = stack.worker.exits.length;

    runId = await stack.api.startRun(workspace, workflowId);
    facts = await waitForRunsToEnd(stack, [runId], RUN_LIMIT_MS);
    await startService('artifact-store');
  }, SCENARIO_LIMIT_MS);

  afterAll(async () => {
    await startService('artifact-store');
    await stack.close();
  }, SCENARIO_LIMIT_MS);

  // performance-03: the worker exits within seconds of the store going away.
  it.fails('keeps the worker running', () => {
    expect(exitsDuringOutage).toBe(0);
  });

  // performance-03: workflows that never touch a file stop until the store returns.
  it.fails('still runs a workflow that touches no files', () => {
    expect(facts[runId]?.status).toBe('succeeded');
    expect(stack.sink.calls('no-files-one')).toHaveLength(1);
    expect(stack.sink.calls('no-files-two')).toHaveLength(1);
  });
});
