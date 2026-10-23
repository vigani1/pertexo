import { describe } from 'vitest';

import { registerRetainsCodeDiagnosticsSafePreviewWithout } from './handler/retains-code-diagnostics-safe-preview-without.cases.js';
import { registerReturnsDuplicatesWithoutInvokingExecutor } from './handler/returns-duplicates-without-invoking-executor.cases.js';
import { registerPropagatesInfrastructureFailuresBoundedQueueRetries } from './handler/propagates-infrastructure-failures-bounded-queue-retries.cases.js';
import { registerCommitsDeadlineTruthBeforeDrainingCancellation } from './handler/commits-deadline-truth-before-draining-cancellation.cases.js';
describe('preview attempt handler', () => {
  registerRetainsCodeDiagnosticsSafePreviewWithout();

  registerReturnsDuplicatesWithoutInvokingExecutor();

  registerPropagatesInfrastructureFailuresBoundedQueueRetries();

  registerCommitsDeadlineTruthBeforeDrainingCancellation();
});
