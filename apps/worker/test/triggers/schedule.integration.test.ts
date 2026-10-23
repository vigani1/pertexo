import { afterAll, beforeAll } from 'vitest';

import {
  describeIntegration,
  prepareDirectScheduleWorkerIntegrationGateFixture,
  closeDirectScheduleWorkerIntegrationGateFixture,
} from './schedule/fixture.js';
import { registerKeepsPostgreSQLAuthoritativeThroughReconciliationContention } from './schedule/keeps-postgre-sqlauthoritative-through-reconciliation-contention.cases.js';
describeIntegration('direct Schedule worker integration gate', () => {
  beforeAll(prepareDirectScheduleWorkerIntegrationGateFixture, 60_000);

  afterAll(closeDirectScheduleWorkerIntegrationGateFixture, 60_000);
  registerKeepsPostgreSQLAuthoritativeThroughReconciliationContention();
});
