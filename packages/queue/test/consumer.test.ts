import { resetPackagesQueueTestConsumerTestTsBullMQQueueConsumerFixture } from './consumer/fixture.js';
import { beforeEach, describe } from 'vitest';

import { registerMapsQueueDefaultsBullMQWorkerDedicated } from './consumer/maps-queue-defaults-bull-mqworker-dedicated.cases.js';
import { registerIsolatesObserverAdmissionFailuresWithoutUnpaired } from './consumer/isolates-observer-admission-failures-without-unpaired.cases.js';
import { registerBecomesReadyAfterBullMQIsReady } from './consumer/becomes-ready-after-bull-mqis-ready.cases.js';
import { registerDisconnectsBullMQBlockingOwnedRedisConnections } from './consumer/disconnects-bull-mqblocking-owned-redis-connections.cases.js';
describe('BullMQ queue consumer', () => {
  beforeEach(resetPackagesQueueTestConsumerTestTsBullMQQueueConsumerFixture);
  registerMapsQueueDefaultsBullMQWorkerDedicated();

  registerIsolatesObserverAdmissionFailuresWithoutUnpaired();

  registerBecomesReadyAfterBullMQIsReady();

  registerDisconnectsBullMQBlockingOwnedRedisConnections();
});
