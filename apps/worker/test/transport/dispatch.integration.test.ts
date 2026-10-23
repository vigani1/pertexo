import { beforeAll, afterAll } from 'vitest';

import {
  describeIntegration,
  prepareWorkerPostgreSQLRedisTransportProofFixture,
  closeWorkerPostgreSQLRedisTransportProofFixture,
} from './dispatch/fixture.js';
import { registerPublishesEveryTargetOutboxIDUnder } from './dispatch/publishes-every-target-outbox-idunder.cases.js';
import { registerReclaimsEnqueueBeforeMarkBullRedelivery } from './dispatch/reclaims-enqueue-before-mark-bull-redelivery.cases.js';
describeIntegration(
  'worker PostgreSQL + Redis transport proof',
  { concurrent: false },
  () => {
    beforeAll(prepareWorkerPostgreSQLRedisTransportProofFixture);
    afterAll(closeWorkerPostgreSQLRedisTransportProofFixture);
    registerPublishesEveryTargetOutboxIDUnder();

    registerReclaimsEnqueueBeforeMarkBullRedelivery();
  },
);
