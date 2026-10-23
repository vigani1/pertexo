import { afterAll, beforeAll } from 'vitest';

import { coordinatorFixture as fixture } from '../../support/coordinator/consumer.js';

import { qualified } from './execution/fixture.js';
import { registerExecutesEveryPinnedTransformTwoBody } from './execution/executes-every-pinned-transform-two-body.cases.js';
qualified(
  'bounded transforms through compiled workers and durable loops',
  () => {
    beforeAll(fixture.setup, 60_000);
    afterAll(fixture.restoreServicesAndClose);
    registerExecutesEveryPinnedTransformTwoBody();
  },
);
