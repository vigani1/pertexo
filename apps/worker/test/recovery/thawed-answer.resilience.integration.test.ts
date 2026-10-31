import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  describeFaults,
  RECOVERY_LIMIT_MS,
  SCENARIO_LIMIT_MS,
} from '../support/recovery/environment.js';
import {
  activeRuns,
  delay,
  waitForRunsToEnd,
  type RunFacts,
} from '../support/recovery/facts.js';
import {
  nextStep,
  releasedStep,
  startFlow,
} from '../support/recovery/flows.js';
import type { ServiceProcess } from '../support/recovery/processes.js';
import { startStack, type Stack } from '../support/recovery/stack.js';

const DISPATCH_LIMIT_MS = 30_000;
const STEP = 'thawed-answer';
const AFTER = 'after-thawed-answer';
// The answer reaches the frozen worker's socket before it wakes.
const ANSWER_LANDS_MS = 1_000;
// The woken worker reads that answer and tries to complete with it in this time.
const THAW_SETTLE_MS = 20_000;

type Holder = Readonly<{
  fence_token: number;
  lease_owner: string | null;
  status: string;
}>;

/**
 * A safe step may run twice, so its second holder can be mid-call when the first
 * wakes up with an answer in hand. Nothing but the lease says the step has moved
 * on: the attempt is still `running`, so the first holder's completion looks like
 * any other. Its answer has to go nowhere, or the run moves on while the holder is
 * still working, and the holder's answer comes back to a step that has ended.
 */
describeFaults(
  'a worker that wakes with an answer for a step held by another',
  () => {
    let stack: Stack;
    let second: ServiceProcess;
    let runId: string;
    let workspace: string;
    let heldBefore: Holder | undefined;
    let heldAfter: Holder | undefined;
    let runWhileHeld: string | undefined;
    let stepsAfterWhileHeld: number;
    let facts: Readonly<Record<string, RunFacts>>;
    let output: string | undefined;
    let active: number;

    const holder = async (): Promise<Holder | undefined> =>
      (
        await stack.sql<Holder>(
          `select a.status, a.lease_owner, a.fence_token
           from app.node_attempts a
           join app.node_runs n on n.id=a.node_run_id and n.workspace_id=a.workspace_id
          where n.workflow_run_id=$1 and n.node_id='released'`,
          [runId],
        )
      )[0];

    beforeAll(async () => {
      stack = await startStack('thawed-answer');
      workspace = await stack.api.createWorkspace('recovery-thawed');
      runId = await startFlow(stack, workspace, 'thawed', [
        releasedStep(stack, STEP, 'GET'),
        nextStep(stack, AFTER),
      ]);
      await stack.sink.waitForCalls(STEP, 1, DISPATCH_LIMIT_MS);

      second = stack.createWorker('recovery-worker-second');
      second.start();
      await second.waitForLog(/worker\.started/u, DISPATCH_LIMIT_MS * 4);

      stack.worker.signal('SIGSTOP');
      // Its lease runs out, the other worker's scan reclaims the step and calls again.
      await stack.sink.waitForCalls(STEP, 2, RECOVERY_LIMIT_MS);
      heldBefore = await holder();

      stack.sink.release(STEP, 1);
      await delay(ANSWER_LANDS_MS);
      stack.worker.signal('SIGCONT');
      await delay(THAW_SETTLE_MS);

      heldAfter = await holder();
      runWhileHeld = (
        await stack.sql<{ status: string }>(
          `select status from app.workflow_runs where id=$1`,
          [runId],
        )
      )[0]?.status;
      stepsAfterWhileHeld = stack.sink.calls(AFTER).length;

      stack.sink.release(STEP, 2);
      facts = await waitForRunsToEnd(stack, [runId], RECOVERY_LIMIT_MS);
      output = (
        await stack.sql<{ output: string }>(
          `select n.output_ref::text as output from app.node_runs n
          where n.workflow_run_id=$1 and n.node_id='released'`,
          [runId],
        )
      )[0]?.output;
      active = await activeRuns(stack, workspace);
    }, SCENARIO_LIMIT_MS);

    afterAll(async () => {
      await stack.close();
    }, SCENARIO_LIMIT_MS);

    it('really has a new holder working when the first worker wakes', () => {
      expect(heldBefore).toMatchObject({
        lease_owner: 'recovery-worker-second',
        status: 'running',
      });
    });

    it('leaves the step with its holder', () => {
      expect(heldAfter).toEqual(heldBefore);
    });

    it('does not move the run on', () => {
      expect(runWhileHeld).toBe('running');
      expect(stepsAfterWhileHeld).toBe(0);
    });

    it("ends the run once, on the holder's answer", () => {
      expect(facts[runId]?.status).toBe('succeeded');
      expect(stack.sink.calls(STEP)).toHaveLength(2);
      expect(stack.sink.calls(AFTER)).toHaveLength(1);
      expect(output).toContain('"call":2');
      expect(output).not.toContain('"call":1');
    });

    it('leaves no capacity held', () => {
      expect(active).toBe(0);
    });
  },
);
