import { describe } from 'vitest';

import { registerReconcilesExpiredAttemptsByDispatch } from './worker-reconciliation/reconciles-expired-attempts-by-dispatch.cases.js';
import { registerDurablySchedulesReschedulesDeduplicatesLease } from './worker-reconciliation/durably-schedules-reschedules-deduplicates-lease.cases.js';
import { registerRecordsUnsafePostDispatchAmbiguity } from './worker-reconciliation/records-unsafe-post-dispatch-ambiguity.cases.js';
describe('preview worker lease reconciliation', () => {
  registerReconcilesExpiredAttemptsByDispatch();

  registerDurablySchedulesReschedulesDeduplicatesLease();

  registerRecordsUnsafePostDispatchAmbiguity();
});
