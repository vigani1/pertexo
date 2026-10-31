import { QUEUE_NAME } from '@pertexo/queue';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  describeFaults,
  SCENARIO_LIMIT_MS,
} from '../../support/recovery/environment.js';
import { delay } from '../../support/recovery/facts.js';
import {
  publishMaintenancePromises,
  QUIET_MS,
  type KeptPromises,
  type MaintenancePromises,
} from '../../support/recovery/promises/maintenance.js';
import { resumeQueue } from '../../support/recovery/queues.js';

/**
 * A backlog, not a loss: the jobs are still in Redis, only later than anything
 * would expect. Whatever recovers a lost job can't tell the two apart in advance,
 * so a replacement and the original may both arrive, and the effect still has to
 * happen once.
 */
describeFaults('jobs on the maintenance queue, late but not lost', () => {
  let promises: MaintenancePromises;
  let kept: KeptPromises;

  beforeAll(async () => {
    promises = await publishMaintenancePromises('late-maintenance');
    await delay(QUIET_MS);
    await resumeQueue(promises.stack, QUEUE_NAME.maintenance);
    kept = await promises.settle();
  }, SCENARIO_LIMIT_MS);

  afterAll(async () => {
    await promises.close();
  }, SCENARIO_LIMIT_MS);

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

  // Otherwise each is delivered again for a day, and then reads as stuck.
  it('has every job kind confirmed by its consumer', () => {
    expect(kept.unconfirmed).toEqual([]);
  });

  it('marks the connection as needing reauthorization', () => {
    expect(kept.connection).toBe('reauthorization_required');
  });
});
