import { beforeEachFixture1 } from './telemetry/fixture.js';

import { beforeEach, describe } from 'vitest';

import { registerDoesNotMistakeUndefinedPool } from './telemetry/does-not-mistake-undefined-pool.cases.js';
import { registerPreservesCallbackQueryReceiverResult } from './telemetry/preserves-callback-query-receiver-result.cases.js';
import { registerPreservesCallbackCheckoutReceiverValues } from './telemetry/preserves-callback-checkout-receiver-values.cases.js';
import { registerSamplesLockWaitsOnDedicated } from './telemetry/samples-lock-waits-on-dedicated.cases.js';
describe('PostgreSQL telemetry pool', () => {
  beforeEach(beforeEachFixture1);
  registerDoesNotMistakeUndefinedPool();

  registerPreservesCallbackQueryReceiverResult();

  registerPreservesCallbackCheckoutReceiverValues();

  registerSamplesLockWaitsOnDedicated();
});
