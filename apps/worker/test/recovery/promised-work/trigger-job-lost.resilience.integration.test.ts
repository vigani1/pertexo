import { QUEUE_NAME } from '@pertexo/queue';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  describeFaults,
  RECOVERY_LIMIT_MS,
  SCENARIO_LIMIT_MS,
} from '../../support/recovery/environment.js';
import { delay } from '../../support/recovery/facts.js';
import { nextStep } from '../../support/recovery/flows.js';
import { triggeredChain } from '../../support/recovery/graphs.js';
import {
  pauseQueue,
  queuedJobs,
  waitForPublished,
} from '../../support/recovery/queues.js';
import { startStack, type Stack } from '../../support/recovery/stack.js';
import { triggerStatus } from '../../support/recovery/triggers.js';

// One interval of the schedule on top of the recovery itself.
const FIRST_FIRE_LIMIT_MS = RECOVERY_LIMIT_MS + 90_000;

/**
 * Publishing says the workflow is live, and that is all the owner is told. The
 * job that turns the published triggers on is published to Redis and lost: no
 * occurrence is ever due, and no webhook can be set up. The same flow with its
 * job delivered is what `arrivals-job-lost` starts from.
 */
describeFaults('a published workflow whose trigger job was lost', () => {
  let stack: Stack;
  let scheduledStatus: string | undefined;
  let hookedStatus: string;
  let provisionStatus: number;
  let jobsLeftInRedis: number;
  let eventStatus: number | undefined;

  beforeAll(async () => {
    stack = await startStack('lost-trigger-job');
    const workspace = await stack.api.createWorkspace('recovery-trigger-job');
    await pauseQueue(stack, QUEUE_NAME.triggerLifecycle);
    const scheduled = await stack.api.publish(
      workspace,
      'scheduled',
      triggeredChain(
        {
          key: 'core.schedule',
          config: { kind: 'interval', intervalMinutes: 1 },
        },
        [nextStep(stack, 'scheduled')],
      ),
    );
    const hooked = await stack.api.publish(
      workspace,
      'hooked',
      triggeredChain({ key: 'core.webhook' }, [nextStep(stack, 'hooked')]),
    );
    await waitForPublished(stack, { 'reconcile-workflow-triggers': 2 });
    await stack.flushRedis();
    jobsLeftInRedis = await queuedJobs(stack, QUEUE_NAME.triggerLifecycle);

    const deadline = Date.now() + FIRST_FIRE_LIMIT_MS;
    while (stack.sink.calls('scheduled').length === 0 && Date.now() < deadline)
      await delay(1_000);

    scheduledStatus = await triggerStatus(stack, scheduled);
    const trigger = await stack.api.readTrigger(workspace, hooked);
    hookedStatus = trigger.status;
    const provisioned = await stack.api.provisionWebhook(
      workspace,
      hooked,
      trigger.id,
    );
    provisionStatus = provisioned.status;
    if (provisioned.status === 200) {
      const event = await stack.api.sendWebhook(
        provisioned.json as Parameters<Stack['api']['sendWebhook']>[0],
        { order: 1 },
      );
      eventStatus = event.status;
      await stack.sink.waitForCalls('hooked', 1, RECOVERY_LIMIT_MS);
    }
  }, SCENARIO_LIMIT_MS);

  afterAll(async () => {
    await stack.close();
  }, SCENARIO_LIMIT_MS);

  it('really lost the job', () => {
    expect(jobsLeftInRedis).toBe(0);
  });

  // reliability-code-01: the schedule row is never created, so no occurrence ever comes.
  it.fails('turns the schedule on, and it fires', () => {
    expect(scheduledStatus).toBe('active');
    expect(stack.sink.calls('scheduled').length).toBeGreaterThan(0);
  });

  // reliability-code-01: the trigger stays `desired` and provisioning answers a conflict forever.
  it.fails('lets the owner set up the webhook, and it runs', () => {
    expect(hookedStatus).toBe('configuration_required');
    expect(provisionStatus).toBe(200);
    expect(eventStatus).toBe(202);
    expect(stack.sink.calls('hooked')).toHaveLength(1);
  });
});
