import { describe } from 'vitest';

import { registerRejectsInvalidConnectionTestBodyBefore } from './use-cases/rejects-invalid-connection-test-body-before.cases.js';
import { registerTestsResendAfterDisclosureOneFixed } from './use-cases/tests-resend-after-disclosure-one-fixed.cases.js';
import { registerPersistsRedactedSecurityFailureButAbandons } from './use-cases/persists-redacted-security-failure-but-abandons.cases.js';
import { registerRejectsDecryptedCredentialNonObjectJSON } from './use-cases/rejects-decrypted-credential-non-object-json.cases.js';
describe('connection testing use case', () => {
  registerRejectsInvalidConnectionTestBodyBefore();

  registerTestsResendAfterDisclosureOneFixed();

  registerPersistsRedactedSecurityFailureButAbandons();

  registerRejectsDecryptedCredentialNonObjectJSON();
});
