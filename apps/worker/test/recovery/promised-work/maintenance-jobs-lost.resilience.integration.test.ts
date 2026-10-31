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

  it('starts the error workflow, once', () => {
    expect(kept.errorWorkflowRuns).toBe(1);
    expect(kept.errorWorkflowSteps).toBe(1);
  });

  it('sends the failure alert, once', () => {
    expect(kept.alert).toBe('delivered');
    expect(kept.alertsSent).toBe(1);
  });

  it('creates and runs the replay, once', () => {
    expect(kept.replay).toBe('completed');
    expect(kept.replayedSteps).toBe(2);
  });

  it('sends the invitation, once', () => {
    expect(kept.invitation).toBe('submitted');
    expect(kept.invitationsSent).toBe(1);
  });

  it('marks the connection as needing reauthorization', () => {
    expect(kept.connection).toBe('reauthorization_required');
  });
});
