import { afterAll, beforeAll, describe } from 'vitest';

import {
  prepareBetterAuthPostgresIntegrationTestTs,
  closeBetterAuthPostgresIntegrationTestTs,
} from './better-auth-postgres/fixture.js';
import { registerLinksFixtureProviderAfterFreshExisting } from './better-auth-postgres/links-fixture-provider-after-fresh-existing.cases.js';
import { registerCommitsEncryptedAuthenticationMailBeforeAcknowledging } from './better-auth-postgres/commits-encrypted-authentication-mail-before-acknowledging.cases.js';
import { registerCommitsOwnedProofSealedVerificationMail } from './better-auth-postgres/commits-owned-proof-sealed-verification-mail.cases.js';
import { registerConsumesInitialVerificationOnceUnderConcurrent } from './better-auth-postgres/consumes-initial-verification-once-under-concurrent.cases.js';
import { registerUsesStableUserRowVerifiesEmail } from './better-auth-postgres/uses-stable-user-row-verifies-email.cases.js';
import { registerRollsBackPasswordChangeSessionRevocation } from './better-auth-postgres/rolls-back-password-change-session-revocation.cases.js';
import { registerConsumesResetProofCredentialChangeRevocation } from './better-auth-postgres/consumes-reset-proof-credential-change-revocation.cases.js';
import { registerRevokesSessionsAtomicallyCanonicalEmailUpdate } from './better-auth-postgres/revokes-sessions-atomically-canonical-email-update.cases.js';
import { registerRevokesSameBrowserAuthorityOwnedWorkspace } from './better-auth-postgres/revokes-same-browser-authority-owned-workspace.cases.js';
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
