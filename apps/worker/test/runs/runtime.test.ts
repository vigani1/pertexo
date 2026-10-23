import { describe } from 'vitest';

import { registerRollsBackEveryOwnerAcquiredBefore } from './runtime/rolls-back-every-owner-acquired-before.cases.js';
import { registerAttemptsEverySynchronousRejectedCloserPreserves } from './runtime/attempts-every-synchronous-rejected-closer-preserves.cases.js';
import { registerReportsBoundedShutdownFailureDefersAdapters } from './runtime/reports-bounded-shutdown-failure-defers-adapters.cases.js';
describe('coordinator runtime', () => {
  registerRollsBackEveryOwnerAcquiredBefore();

  registerAttemptsEverySynchronousRejectedCloserPreserves();

  registerReportsBoundedShutdownFailureDefersAdapters();
});
