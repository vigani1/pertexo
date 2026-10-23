import { afterAll, beforeAll } from 'vitest';

import { coordinatorFixture as fixture } from '../../support/coordinator/consumer.js';

import { qualified } from './failure-routing/fixture.js';
import { registerRetainsSourceFailureTruthResumesSelected } from './failure-routing/retains-source-failure-truth-resumes-selected.cases.js';
qualified(
  'failure handlers through durable outbox and compiled workers',
  () => {
    beforeAll(fixture.setup, 60_000);
    afterAll(fixture.restoreServicesAndClose);
    registerRetainsSourceFailureTruthResumesSelected();
  },
);
