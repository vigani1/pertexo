import { describe } from 'vitest';

import { betterAuthIntegrationEnabled } from '../../../support/better-auth/real-api.support.js';

import { createDirectoryFixture } from './provisioning/fixture.js';
import { registerFailsClosedBeforeDatabaseAuthenticationEnforcesShared } from './provisioning/fails-closed-before-database-authentication-enforces-shared.cases.js';
import { registerBindsThroughVerifiedSSOUnprovisionedJITOff } from './provisioning/binds-through-verified-ssounprovisioned-jitoff.cases.js';
describe.skipIf(!betterAuthIntegrationEnabled)(
  'SCIM on the real API and PostgreSQL',
  () => {
    const caseFixture = createDirectoryFixture();

    registerFailsClosedBeforeDatabaseAuthenticationEnforcesShared(caseFixture);

    registerBindsThroughVerifiedSSOUnprovisionedJITOff(caseFixture);
  },
);
