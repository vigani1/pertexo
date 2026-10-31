import { QUEUE_NAME } from '@pertexo/queue';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  describeFaults,
  SCENARIO_LIMIT_MS,
} from '../../support/recovery/environment.js';
import { delay } from '../../support/recovery/facts.js';
import {
  publishMaintenancePromises,
  type KeptPromises,
  type MaintenancePromises,
} from '../../support/recovery/promises/maintenance.js';
import { failedJobs, resumeQueue } from '../../support/recovery/queues.js';
import { startService, stopService } from '../../support/recovery/services.js';

// A job has 8 tries over about two minutes. Past that it is in Redis's failed set,
// where nothing reads it again: as lost as if Redis had dropped it.
const OUTAGE_MS = 150_000;

describeFaults('maintenance jobs that outlast their retries', () => {
  let promises: MaintenancePromises;
  let kept: KeptPromises;
  let jobsOutOfRetries: number;

  beforeAll(async () => {
    promises = await publishMaintenancePromises('exhausted-maintenance');
    await stopService('postgres');
    await resumeQueue(promises.stack, QUEUE_NAME.maintenance);
    await delay(OUTAGE_MS);
    await startService('postgres');
    jobsOutOfRetries = await failedJobs(promises.stack, QUEUE_NAME.maintenance);
    kept = await promises.settle();
  }, SCENARIO_LIMIT_MS);

  afterAll(async () => {
    await startService('postgres');
    await promises.close();
  }, SCENARIO_LIMIT_MS);

  it('really used up the retries of every job', () => {
    expect(jobsOutOfRetries).toBe(5);
  });

  // reliability-code-01: a Postgres restart longer than the retries loses the promise.
  it.fails('starts the error workflow, once', () => {
    expect(kept.errorWorkflowRuns).toBe(1);
    expect(kept.errorWorkflowSteps).toBe(1);
  });

  // reliability-code-01: as above.
  it.fails('sends the failure alert, once', () => {
    expect(kept.alert).toBe('delivered');
    expect(kept.alertsSent).toBe(1);
  });

  // reliability-code-01: as above.
  it.fails('creates and runs the replay, once', () => {
    expect(kept.replay).toBe('completed');
    expect(kept.replayedSteps).toBe(2);
  });

  // reliability-code-01: as above.
  it.fails('sends the invitation, once', () => {
    expect(kept.invitation).toBe('submitted');
    expect(kept.invitationsSent).toBe(1);
  });

  // reliability-code-01: as above.
  it.fails('marks the connection as needing reauthorization', () => {
    expect(kept.connection).toBe('reauthorization_required');
  });
});
