import { QUEUE_NAME } from '@pertexo/queue';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  describeFaults,
  SCENARIO_LIMIT_MS,
} from '../../support/recovery/environment.js';
import {
  publishMaintenancePromises,
  type KeptPromises,
  type MaintenancePromises,
} from '../../support/recovery/promises/maintenance.js';
import { queuedJobs } from '../../support/recovery/queues.js';

/**
 * Each job here was published and then lost, the way a Redis rebuilt from nothing
 * loses it. Nothing else will ever ask for this work again, so it has to come
 * back by itself. `maintenance-jobs-late` proves these fixtures can keep each
 * promise: there the same jobs are only late.
 */
describeFaults('jobs on the maintenance queue, published then lost', () => {
  let promises: MaintenancePromises;
  let jobsLeftInRedis: number;
  let kept: KeptPromises;

  beforeAll(async () => {
    promises = await publishMaintenancePromises('lost-maintenance');
    await promises.stack.flushRedis();
    jobsLeftInRedis = await queuedJobs(promises.stack, QUEUE_NAME.maintenance);
    kept = await promises.settle();
  }, SCENARIO_LIMIT_MS);

  afterAll(async () => {
    await promises.close();
  }, SCENARIO_LIMIT_MS);

  it('really lost the jobs', () => {
    expect(jobsLeftInRedis).toBe(0);
  });

  // reliability-code-01: the source run failed and nothing ever starts its error workflow.
  it.fails('starts the error workflow, once', () => {
    expect(kept.errorWorkflowRuns).toBe(1);
    expect(kept.errorWorkflowSteps).toBe(1);
  });

  // reliability-code-01: the intent stays `pending`; recovery knows only claimed and dispatching.
  it.fails('sends the failure alert, once', () => {
    expect(kept.alert).toBe('delivered');
    expect(kept.alertsSent).toBe(1);
  });

  // reliability-code-01: the operator was told the replay is pending, and it stays so.
  it.fails('creates and runs the replay, once', () => {
    expect(kept.replay).toBe('completed');
    expect(kept.replayedSteps).toBe(2);
  });

  // reliability-code-01: the owner sees an invitation that was never sent.
  it.fails('sends the invitation, once', () => {
    expect(kept.invitation).toBe('submitted');
    expect(kept.invitationsSent).toBe(1);
  });

  // reliability-code-01: Slack said the token is revoked; the page still says it is fine.
  it.fails('marks the connection as needing reauthorization', () => {
    expect(kept.connection).toBe('reauthorization_required');
  });
});
