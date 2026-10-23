import { afterAll, beforeAll } from 'vitest';

import { coordinatorFixture as fixture } from '../../support/coordinator/consumer.js';

import { qualified } from './recovery/fixture.js';
import { registerOwnsPrefixValuesFreezesChoiceExecutes } from './recovery/owns-prefix-values-freezes-choice-executes.cases.js';
qualified(
  'atomic recovery through the real outbox, BullMQ and compiled workers',
  () => {
    beforeAll(fixture.setup, 60_000);
    afterAll(fixture.restoreServicesAndClose);
    registerOwnsPrefixValuesFreezesChoiceExecutes();
  },
);
