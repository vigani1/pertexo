import { describe } from 'vitest';

import { betterAuthIntegrationEnabled } from '../../support/better-auth/real-api.support.js';

import {
  createAuthenticatorFixture,
  createRecoveryFixture,
  createFactorManagementFixture,
  createFactorResetFixture,
  createFactorLockoutFixture,
  createFactorOrganizationFixture,
  createFactorAdmissionFixture,
} from './sign-in/fixture.js';
import { registerRequiresCodeRefusesWrongCodeCreatesFresh } from './sign-in/requires-code-refuses-wrong-code-creates-fresh.cases.js';
import { registerConsumesRecoveryCodeOnceIncludingConcurrentAPI } from './sign-in/consumes-recovery-code-once-including-concurrent-api.cases.js';
import { registerRequiresPasswordFreshSessionCSRFReplaceCodes } from './sign-in/requires-password-fresh-session-csrfreplace-codes.cases.js';
import { registerPreservesSecondFactorAfterPasswordResetBlocks } from './sign-in/preserves-second-factor-after-password-reset-blocks.cases.js';
import { registerEnforcesPluginAccountLockoutResetsExpiredFailure } from './sign-in/enforces-plugin-account-lockout-resets-expired-failure.cases.js';
import { registerRefusesPendingCodeChallengeAfterOrganizationEnforcement } from './sign-in/refuses-pending-code-challenge-after-organization-enforcement.cases.js';
import { registerChargesPasswordBothCodeRoutesSameDistributed } from './sign-in/charges-password-both-code-routes-same-distributed.cases.js';
describe.skipIf(!betterAuthIntegrationEnabled)(
  'two-factor codes on the real API',
  () => {
    const caseFixture = createAuthenticatorFixture();

    registerRequiresCodeRefusesWrongCodeCreatesFresh(caseFixture);
  },
);
describe.skipIf(!betterAuthIntegrationEnabled)(
  'two-factor recovery on the real API',
  () => {
    const caseFixture = createRecoveryFixture();

    registerConsumesRecoveryCodeOnceIncludingConcurrentAPI(caseFixture);
  },
);
describe.skipIf(!betterAuthIntegrationEnabled)(
  'two-factor management on the real API',
  () => {
    const caseFixture = createFactorManagementFixture();

    registerRequiresPasswordFreshSessionCSRFReplaceCodes(caseFixture);
  },
);
describe.skipIf(!betterAuthIntegrationEnabled)(
  'two-factor reset on the real API',
  () => {
    const caseFixture = createFactorResetFixture();

    registerPreservesSecondFactorAfterPasswordResetBlocks(caseFixture);
  },
);
for (const backup of [false, true])
  describe.skipIf(!betterAuthIntegrationEnabled)(
    `two-factor ${backup ? 'recovery-code' : 'authenticator'} lockout on the real API`,
    () => {
      const caseFixture = createFactorLockoutFixture({ backup });

      registerEnforcesPluginAccountLockoutResetsExpiredFailure(caseFixture);
    },
  );
describe.skipIf(!betterAuthIntegrationEnabled)(
  'two-factor organization on the real API',
  () => {
    const caseFixture = createFactorOrganizationFixture();

    registerRefusesPendingCodeChallengeAfterOrganizationEnforcement(
      caseFixture,
    );
  },
);
describe.skipIf(!betterAuthIntegrationEnabled)(
  'distributed second-factor admission on the real API',
  () => {
    const caseFixture = createFactorAdmissionFixture();

    registerChargesPasswordBothCodeRoutesSameDistributed(caseFixture);
  },
);
