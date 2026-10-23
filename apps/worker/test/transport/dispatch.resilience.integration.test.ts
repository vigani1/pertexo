import { describeResilience } from './dispatch.resilience/fixture.js';
import { registerRecoversPostgreSQLAuthorityAcrossRedisQueue } from './dispatch.resilience/recovers-postgre-sqlauthority-across-redis-queue.cases.js';
describeResilience(
  'worker transport service-loss resilience proof',
  { concurrent: false },
  () => {
    registerRecoversPostgreSQLAuthorityAcrossRedisQueue();
  },
);
