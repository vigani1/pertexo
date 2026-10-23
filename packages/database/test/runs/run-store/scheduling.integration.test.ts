import { describe } from 'vitest';

import { registerDefersQueuedCoordinationDurablyUntil } from './scheduling/admission/defers-queued-coordination-durably-until.cases.js';
import { registerReturnsCommittedSchedulePostCommit } from './scheduling/admission/returns-committed-schedule-post-commit.cases.js';
import { registerPreservesOneQueuedTimeoutIntent } from './scheduling/admission/preserves-one-queued-timeout-intent.cases.js';
import { registerRecordsOneWorkspaceInboxFailure } from './scheduling/notifications/records-one-workspace-inbox-failure.cases.js';
import { registerRejectsEachForgedQueueIdentity } from './scheduling/notifications/rejects-each-forged-queue-identity.cases.js';
import { registerDistinguishesBusyDueBoundaryTerminal } from './scheduling/notifications/distinguishes-busy-due-boundary-terminal.cases.js';
import { registerRollsBackEveryCompletionWrite } from './scheduling/notifications/rolls-back-every-completion-write.cases.js';
import { registerCancelsCompletionBeforeCheckoutIntent } from './scheduling/notifications/cancels-completion-before-checkout-intent.cases.js';
import { registerEnforcesDestinationDisableDispatchFencing } from './scheduling/notifications/enforces-destination-disable-dispatch-fencing.cases.js';
import { registerRejectsPermanentlyRevokedDestinationCredential } from './scheduling/notifications/rejects-permanently-revoked-destination-credential.cases.js';
import { registerPinsSecretRotationRetryRecovery } from './scheduling/notifications/pins-secret-rotation-retry-recovery.cases.js';
import { registerExcludesPolicyPinnedCanceledTransition } from './scheduling/notifications/excludes-policy-pinned-canceled-transition.cases.js';
describe('Coordinator scheduling and notification invariants', () => {
  registerDefersQueuedCoordinationDurablyUntil();

  registerReturnsCommittedSchedulePostCommit();

  registerPreservesOneQueuedTimeoutIntent();

  registerRecordsOneWorkspaceInboxFailure();

  registerRejectsEachForgedQueueIdentity();

  registerDistinguishesBusyDueBoundaryTerminal();

  registerRollsBackEveryCompletionWrite();

  registerCancelsCompletionBeforeCheckoutIntent();

  registerEnforcesDestinationDisableDispatchFencing();

  registerRejectsPermanentlyRevokedDestinationCredential();

  registerPinsSecretRotationRetryRecovery();

  registerExcludesPolicyPinnedCanceledTransition();
});
