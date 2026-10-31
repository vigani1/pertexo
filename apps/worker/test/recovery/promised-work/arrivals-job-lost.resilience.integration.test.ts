import { QUEUE_NAME } from '@pertexo/queue';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  describeFaults,
  RECOVERY_LIMIT_MS,
  SCENARIO_LIMIT_MS,
} from '../../support/recovery/environment.js';
import {
  delay,
  runFacts,
  type RunFacts,
} from '../../support/recovery/facts.js';
import { nextStep } from '../../support/recovery/flows.js';
import { triggeredChain } from '../../support/recovery/graphs.js';
import {
  pauseQueue,
  queuedJobs,
  waitForPublished,
} from '../../support/recovery/queues.js';
import { startStack, type Stack } from '../../support/recovery/stack.js';
import {
  waitForScheduleReady,
  waitForWebhookKeys,
} from '../../support/recovery/triggers.js';

const EVENT_KEY = 'order-1';
const OCCURRENCE_LIMIT_MS = 90_000;
// A queued run's job is recovered by the admission check, on a 5 minute timer.
const ADMISSION_RECOVERY_LIMIT_MS = 400_000;
const TERMINAL = [
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'outcome_unknown',
];

/**
 * The sender got its 202 and the schedule recorded its occurrence: the accepted
 * run is durable, and only the job that starts it is in Redis. This is the first
 * job of a run, which is `queued` until a worker takes it.
 */
describeFaults('an accepted event whose first job was lost', () => {
  let stack: Stack;
  let accepted: number;
  let jobsLeftInRedis: number;
  let replayOfEvent: { status: number; runId: string | undefined };
  let webhookRun: string;
  let webhookFacts: RunFacts;
  let occurrenceFacts: RunFacts;
  let waited: { occurrence: number; webhook: number };
  let webhookRuns: number;

  const waitForEnd = async (runId: string): Promise<number> => {
    const started = Date.now();
    while (Date.now() - started < ADMISSION_RECOVERY_LIMIT_MS) {
      const { status } = await runFacts(stack, runId);
      if (TERMINAL.includes(status)) break;
      await delay(500);
    }
    return Date.now() - started;
  };

  beforeAll(async () => {
    stack = await startStack('lost-first-job');
    const workspace = await stack.api.createWorkspace('recovery-first-job');
    const hooked = await stack.api.publish(
      workspace,
      'hooked',
      triggeredChain({ key: 'core.webhook' }, [nextStep(stack, 'hooked')]),
    );
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
    await waitForScheduleReady(stack, scheduled);
    const keys = await waitForWebhookKeys(stack, workspace, hooked);

    await pauseQueue(stack, QUEUE_NAME.workflowCoordinator);
    const event = await stack.api.sendWebhook(keys, { order: 1 }, EVENT_KEY);
    accepted = event.status;
    webhookRun = (event.json as { runId: string }).runId;

    const deadline = Date.now() + OCCURRENCE_LIMIT_MS;
    let occurrenceRun: string | undefined;
    while (occurrenceRun === undefined) {
      [{ workflow_run_id: occurrenceRun } = { workflow_run_id: undefined }] =
        await stack.sql<{ workflow_run_id: string }>(
          `select workflow_run_id from app.trigger_schedule_occurrences
            where disposition='accepted' order by scheduled_at limit 1`,
        );
      if (Date.now() > deadline) throw new Error('No occurrence was accepted');
      await delay(200);
    }
    await waitForPublished(stack, { 'advance-workflow-run': 2 });
    await stack.flushRedis();
    jobsLeftInRedis = await queuedJobs(stack, QUEUE_NAME.workflowCoordinator);

    const firstRun = occurrenceRun;
    const [webhookWait, occurrenceWait] = await Promise.all([
      waitForEnd(webhookRun),
      waitForEnd(firstRun),
    ]);
    waited = { occurrence: occurrenceWait, webhook: webhookWait };
    webhookFacts = await runFacts(stack, webhookRun);
    occurrenceFacts = await runFacts(stack, firstRun);

    // The sender never heard back and tries again with the same event key.
    const repeat = await stack.api.sendWebhook(keys, { order: 1 }, EVENT_KEY);
    replayOfEvent = {
      status: repeat.status,
      runId: (repeat.json as { runId?: string }).runId,
    };
    const [count] = await stack.sql<{ count: number }>(
      `select count(*)::int as count from app.workflow_runs where workflow_id=$1`,
      [hooked],
    );
    webhookRuns = count?.count ?? 0;
  }, SCENARIO_LIMIT_MS);

  afterAll(async () => {
    await stack.close();
  }, SCENARIO_LIMIT_MS);

  it('told the sender the event was accepted, then really lost the job', () => {
    expect(accepted).toBe(202);
    expect(jobsLeftInRedis).toBe(0);
  });

  it('still runs the event, exactly once', () => {
    expect(webhookFacts.status).toBe('succeeded');
    expect(stack.sink.calls('hooked')).toHaveLength(1);
  });

  it('answers the sender retrying the same event with the same run', () => {
    expect(replayOfEvent).toEqual({ status: 202, runId: webhookRun });
    expect(webhookRuns).toBe(1);
  });

  it('still runs the occurrence, with one attempt', () => {
    expect(occurrenceFacts.status).toBe('succeeded');
    expect(occurrenceFacts.steps.next).toEqual(['succeeded']);
  });

  // reliability-code-01: `overdueDeliveryAction` drops a `queued` run, so it waits 5 minutes
  // for the admission check, where every other lost run job comes back in about 60 s.
  it.fails('starts an accepted event as soon as any other lost job', () => {
    expect(waited.webhook).toBeLessThan(RECOVERY_LIMIT_MS);
  });

  // reliability-code-01: as above.
  it.fails('starts an occurrence as soon as any other lost job', () => {
    expect(waited.occurrence).toBeLessThan(RECOVERY_LIMIT_MS);
  });
});
