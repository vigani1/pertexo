import { describe } from 'vitest';

import { registerRollsBackOptionalOwnersAcquiredBefore } from './reconciliation/rolls-back-optional-owners-acquired-before.cases.js';
import { registerRoutesEveryEnabledMaintenanceJobDistinct } from './reconciliation/routes-every-enabled-maintenance-job-distinct.cases.js';
import { registerContainsThrowingSTelemetryCallbackWithout } from './reconciliation/contains-throwing-stelemetry-callback-without.cases.js';
import { registerReportsBoundedRecoveryShutdownFailureCloses } from './reconciliation/reports-bounded-recovery-shutdown-failure-closes.cases.js';
describe('preview reconciliation handler', () => {
  registerRollsBackOptionalOwnersAcquiredBefore();

  registerRoutesEveryEnabledMaintenanceJobDistinct();

  registerContainsThrowingSTelemetryCallbackWithout();

  registerReportsBoundedRecoveryShutdownFailureCloses();
});
