import { afterAll, beforeAll } from 'vitest';

import {
  restoreServicesAndClose,
  setup,
  describeIntegration,
} from './retry-wait/fixture.js';
import { registerRecoversDueRetryWaitWorkThrough } from './retry-wait/recovers-due-retry-wait-work-through.cases.js';
import { registerCommitsSimultaneousCancellationDeadlineFactsAgainst } from './retry-wait/commits-simultaneous-cancellation-deadline-facts-against.cases.js';
describeIntegration('Retry and Wait outage recovery', () => {
  beforeAll(setup, 60_000);
  afterAll(restoreServicesAndClose);
  registerRecoversDueRetryWaitWorkThrough();

  registerCommitsSimultaneousCancellationDeadlineFactsAgainst();
});
