import { resetPackagesQueueTestProducerTestTsBullMQQueueProducerFixture } from './producer/fixture.js';
import { beforeEach, describe } from 'vitest';

import { registerDerivesStableNonnumericColonFreeJob } from './producer/derives-stable-nonnumeric-colon-free-job.cases.js';
import { registerRejectsDeferredQueueReadinessAfterClose } from './producer/rejects-deferred-queue-readiness-after-close.cases.js';
describe('BullMQ queue producer', () => {
  beforeEach(resetPackagesQueueTestProducerTestTsBullMQQueueProducerFixture);
  registerDerivesStableNonnumericColonFreeJob();

  registerRejectsDeferredQueueReadinessAfterClose();
});
