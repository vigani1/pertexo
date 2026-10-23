import { afterAll, beforeAll } from 'vitest';

import {
  restoreServicesAndClose,
  setup,
  describeIntegration,
} from './failure-notification/fixture.js';
import { registerRecoversFailureNotificationDispatchThroughPostgreSQL } from './failure-notification/recovers-failure-notification-dispatch-through-postgre-sql.cases.js';
describeIntegration('Failure notification transport resilience', () => {
  beforeAll(setup, 60_000);
  afterAll(restoreServicesAndClose);
  registerRecoversFailureNotificationDispatchThroughPostgreSQL();
});
