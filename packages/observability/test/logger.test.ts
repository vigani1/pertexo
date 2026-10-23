import { afterEach, describe } from 'vitest';

import { cleanPackagesObservabilityTestLoggerTestTsLoggerTestTsFixture } from './logger/fixture.js';
import { registerWritesOneJSONRecordFixedService } from './logger/writes-one-jsonrecord-fixed-service.cases.js';
import { registerAppliesOneTraversalBudgetAcrossWide } from './logger/applies-one-traversal-budget-across-wide.cases.js';
import { registerRedactsPublicFormCapabilityHeadersConfiguration } from './logger/redacts-public-form-capability-headers-configuration.cases.js';
afterEach(cleanPackagesObservabilityTestLoggerTestTsLoggerTestTsFixture);
describe('createStructuredLogger', () => {
  registerWritesOneJSONRecordFixedService();

  registerAppliesOneTraversalBudgetAcrossWide();
});
registerRedactsPublicFormCapabilityHeadersConfiguration();
