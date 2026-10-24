import { describe } from 'vitest';

import { enabled } from './workflow-concurrency/environment.js';
import { createWorkflowConcurrencyJourney } from './workflow-concurrency/fixture.js';
import { registerWorkflowConcurrencyJourney } from './workflow-concurrency/journey.js';

describe.skipIf(!enabled)(
  'real workflow concurrency browser, API and worker',
  () => {
    const fixture = createWorkflowConcurrencyJourney();
    registerWorkflowConcurrencyJourney(fixture);
  },
);
