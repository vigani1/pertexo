import { afterAll, beforeAll } from 'vitest';

import {
  restoreServicesAndClose,
  setup,
  describeIntegration,
} from './foreach-cancellation/fixture.js';
import { registerRecoversBoundedEachBatchesCancellationPostgreSQL } from './foreach-cancellation/recovers-bounded-each-batches-cancellation-postgre-sql.cases.js';
describeIntegration('For Each cancellation recovery', () => {
  beforeAll(setup, 60_000);
  afterAll(restoreServicesAndClose);
  registerRecoversBoundedEachBatchesCancellationPostgreSQL();
});
