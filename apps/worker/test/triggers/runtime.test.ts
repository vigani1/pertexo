import { describe } from 'vitest';

import { registerRollsBackOwnersAcquiredBeforeS } from './runtime/rolls-back-owners-acquired-before-s.cases.js';
import { registerOwnsTriggerLifecycleConsumerPollsPostgreSQL } from './runtime/owns-trigger-lifecycle-consumer-polls-postgre-sql.cases.js';
describe('trigger runtime', () => {
  registerRollsBackOwnersAcquiredBeforeS();

  registerOwnsTriggerLifecycleConsumerPollsPostgreSQL();
});
