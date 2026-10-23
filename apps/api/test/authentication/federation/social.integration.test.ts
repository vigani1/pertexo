import { describe } from 'vitest';

import { betterAuthIntegrationEnabled } from '../../support/better-auth/real-api.support.js';
import { createSocialSignInFixture } from './social/fixture.js';
import { registerLandsAppleCrossSiteFormVerifiesIt } from './social/lands-apple-cross-site-form-verifies-it.cases.js';
import { registerRefusesSUserAfterValidProviderProof } from './social/refuses-suser-after-valid-provider-proof.cases.js';
import { registerRollsBackLinkingAuditRevocationFinalConsumption } from './social/rolls-back-linking-audit-revocation-final-consumption.cases.js';
describe.skipIf(!betterAuthIntegrationEnabled)(
  'browser-bound social sign-in on the real API',
  () => {
    const caseFixture = createSocialSignInFixture();

    registerLandsAppleCrossSiteFormVerifiesIt(caseFixture);

    registerRefusesSUserAfterValidProviderProof(caseFixture);

    registerRollsBackLinkingAuditRevocationFinalConsumption(caseFixture);
  },
);
