import { describe } from 'vitest';

import { betterAuthIntegrationEnabled } from '../support/better-auth/real-api.support.js';
import {
  createAutomationApiFixture,
  createDisabledAutomationFixture,
} from './api/fixture.js';
import { registerCreatesOnceThroughRealBrowserSessionAuthenticates } from './api/creates-once-through-real-browser-session-authenticates.cases.js';
import { registerUsesPublishStartCancelReviewedPortabilityCredential } from './api/uses-publish-start-cancel-reviewed-portability-credential.cases.js';
import { registerKeepsMetadataVisibleExplainsDisabledCreationAuthentication } from './api/keeps-metadata-visible-explains-disabled-creation-authentication.cases.js';
describe.runIf(betterAuthIntegrationEnabled)(
  'personal automation HTTP authentication',
  () => {
    const caseFixture = createAutomationApiFixture();

    registerCreatesOnceThroughRealBrowserSessionAuthenticates(caseFixture);

    registerUsesPublishStartCancelReviewedPortabilityCredential(caseFixture);
  },
);
describe.runIf(betterAuthIntegrationEnabled)(
  'disabled automation availability',
  () => {
    const caseFixture = createDisabledAutomationFixture();

    registerKeepsMetadataVisibleExplainsDisabledCreationAuthentication(
      caseFixture,
    );
  },
);
