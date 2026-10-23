import { afterAll, beforeAll, describe } from 'vitest';

import {
  prepareBetterAuthPostgresIntegrationTestTs,
  closeBetterAuthPostgresIntegrationTestTs,
} from './better-auth-postgres/fixture.js';
import { registerLinksFixtureProviderAfterFreshExisting } from './better-auth-postgres/cases/provider-linking.cases.js';
import { registerCommitsEncryptedAuthenticationMailBeforeAcknowledging } from './better-auth-postgres/cases/authentication-mail.cases.js';
import { registerCommitsOwnedProofSealedVerificationMail } from './better-auth-postgres/cases/verification-mail.cases.js';
import { registerConsumesInitialVerificationOnceUnderConcurrent } from './better-auth-postgres/cases/concurrent-verification.cases.js';
import { registerUsesStableUserRowVerifiesEmail } from './better-auth-postgres/cases/account-security.cases.js';
import { registerRollsBackPasswordChangeSessionRevocation } from './better-auth-postgres/cases/password-rollback.cases.js';
import { registerConsumesResetProofCredentialChangeRevocation } from './better-auth-postgres/cases/reset-consumption.cases.js';
import { registerRevokesSessionsAtomicallyCanonicalEmailUpdate } from './better-auth-postgres/cases/email-update.cases.js';
import { registerRevokesSameBrowserAuthorityOwnedWorkspace } from './better-auth-postgres/cases/workspace-removal.cases.js';
beforeAll(prepareBetterAuthPostgresIntegrationTestTs, 60_000);
afterAll(closeBetterAuthPostgresIntegrationTestTs);
describe('Better Auth on PostgreSQL', () => {
  registerLinksFixtureProviderAfterFreshExisting();

  registerCommitsEncryptedAuthenticationMailBeforeAcknowledging();

  registerCommitsOwnedProofSealedVerificationMail();

  registerConsumesInitialVerificationOnceUnderConcurrent();

  registerUsesStableUserRowVerifiesEmail();

  registerRollsBackPasswordChangeSessionRevocation();

  registerConsumesResetProofCredentialChangeRevocation();

  registerRevokesSessionsAtomicallyCanonicalEmailUpdate();

  registerRevokesSameBrowserAuthorityOwnedWorkspace();
});
