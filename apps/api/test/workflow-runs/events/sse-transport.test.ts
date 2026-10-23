import { describe } from 'vitest';

import { registerPerformsOneIdleRefreshWithoutSpinning } from './sse-transport/performs-one-idle-refresh-without-spinning.cases.js';
import { registerWorkflowRunSSETransportRevokesRefreshedSessionLabel } from './sse-transport/workflow-run-ssetransport-revokes-refreshed-session-label.cases.js';
import { registerDoesNotReadAheadTransportIs } from './sse-transport/does-not-read-ahead-transport-is.cases.js';
import { registerClosesActualNestedStreamAfterFailureSource } from './sse-transport/closes-actual-nested-stream-after-failure-source.cases.js';
import { registerStartsTransportCleanupBudgetAuthorizationCleanup } from './sse-transport/starts-transport-cleanup-budget-authorization-cleanup.cases.js';
import { registerRevokesAuthorizationFrameIsBlockedOn } from './sse-transport/revokes-authorization-frame-is-blocked-on.cases.js';
describe('workflow run SSE transport', () => {
  registerPerformsOneIdleRefreshWithoutSpinning();

  registerWorkflowRunSSETransportRevokesRefreshedSessionLabel();

  registerDoesNotReadAheadTransportIs();

  registerClosesActualNestedStreamAfterFailureSource();

  registerStartsTransportCleanupBudgetAuthorizationCleanup();

  registerRevokesAuthorizationFrameIsBlockedOn();
});
