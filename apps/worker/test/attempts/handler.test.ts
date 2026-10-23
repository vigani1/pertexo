import { describe } from 'vitest';

import { registerNodeAttemptHandlerRejectsUnavailablePublishedWorkflow } from './handler/node-attempt-handler-rejects-unavailable-published-workflow.cases.js';
import { registerCommitsResumedWaitOutputOptionalTrace } from './handler/commits-resumed-wait-output-optional-trace.cases.js';
import { registerCommitsPreparedSuspensionExactDuration } from './handler/commits-prepared-suspension-exact-duration.cases.js';
import { registerHandsResolvedInputStoreBeforeExecuting } from './handler/hands-resolved-input-store-before-executing.cases.js';
describe('NodeAttemptHandler', () => {
  registerNodeAttemptHandlerRejectsUnavailablePublishedWorkflow();

  registerCommitsResumedWaitOutputOptionalTrace();

  registerCommitsPreparedSuspensionExactDuration();

  registerHandsResolvedInputStoreBeforeExecuting();
});
