import { describe } from 'vitest';

import { registerRecordsCompletedSSetupTest } from './connection-tests/records-completed-ssetup-test.cases.js';
import { registerDurablyOwnsMarksCompletesExactly } from './connection-tests/durably-owns-marks-completes-exactly.cases.js';
import { registerLinearizesDispatchBeforeConcurrentCredential } from './connection-tests/linearizes-dispatch-before-concurrent-credential.cases.js';
import { registerHoldsActorAuthorityStableUntil } from './connection-tests/holds-actor-authority-stable-until.cases.js';
import { registerRejectsDispatchWithoutAuditEvidence } from './connection-tests/rejects-dispatch-without-audit-evidence.cases.js';
import { registerReleasesPreDispatchFailureNever } from './connection-tests/releases-pre-dispatch-failure-never.cases.js';
describe('connection test ownership', () => {
  registerRecordsCompletedSSetupTest();

  registerDurablyOwnsMarksCompletesExactly();

  registerLinearizesDispatchBeforeConcurrentCredential();

  registerHoldsActorAuthorityStableUntil();

  registerRejectsDispatchWithoutAuditEvidence();

  registerReleasesPreDispatchFailureNever();
});
