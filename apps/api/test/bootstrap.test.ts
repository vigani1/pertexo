import { afterEach, describe } from 'vitest';

import { cleanAPIBootstrapOwnershipHealthFixture } from './bootstrap/fixture.js';
import { registerAcceptsBothEmptyPopulatedTrustedProxy } from './bootstrap/lifecycle/accepts-both-empty-populated-trusted-proxy.cases.js';
import { registerPreservesConstructionEveryRuntimeCleanupFailure } from './bootstrap/lifecycle/preserves-construction-every-runtime-cleanup-failure.cases.js';
import { registerDoesNotRestoreReadinessDrainBegins } from './bootstrap/lifecycle/does-not-restore-readiness-drain-begins.cases.js';
import { registerEntersDrainStateBeforeShutdownResources } from './bootstrap/lifecycle/enters-drain-state-before-shutdown-resources.cases.js';
import { registerClosesRealOpenSSERequestWithout } from './bootstrap/identity/closes-real-open-sserequest-without.cases.js';
import { registerRegistersInjectedIdentityRuntimeOwnsClose } from './bootstrap/identity/registers-injected-identity-runtime-owns-close.cases.js';
import { registerMapsUserRemovedAfterAuthenticationSafe } from './bootstrap/identity/maps-user-removed-after-authentication-safe.cases.js';
import { registerKeepsSuppliedWebhookSSKey } from './bootstrap/identity/keeps-supplied-webhook-sskey.cases.js';
import { registerRegistersRequestedSchedulePreviewActualBetter } from './bootstrap/features/registers-requested-schedule-preview-actual-better.cases.js';
import { registerEnforcesSessionCSRFOnScheduleRoutes } from './bootstrap/features/enforces-session-csrfon-schedule-routes.cases.js';
import { registerRegistersNodeTestingRoutesProvidersProduction } from './bootstrap/features/registers-node-testing-routes-providers-production.cases.js';
import { registerClosesIdentityArtifactRuntimesArtifactStartup } from './bootstrap/features/closes-identity-artifact-runtimes-artifact-startup.cases.js';
describe('API bootstrap ownership and health', () => {
  afterEach(cleanAPIBootstrapOwnershipHealthFixture);
  registerAcceptsBothEmptyPopulatedTrustedProxy();

  registerPreservesConstructionEveryRuntimeCleanupFailure();

  registerDoesNotRestoreReadinessDrainBegins();

  describe('SSE transport shutdown', () => {
    registerClosesRealOpenSSERequestWithout();
  });
  registerEntersDrainStateBeforeShutdownResources();

  describe('feature composition', () => {
    registerRegistersInjectedIdentityRuntimeOwnsClose();

    registerMapsUserRemovedAfterAuthenticationSafe();

    registerKeepsSuppliedWebhookSSKey();

    registerRegistersRequestedSchedulePreviewActualBetter();

    registerEnforcesSessionCSRFOnScheduleRoutes();

    registerRegistersNodeTestingRoutesProvidersProduction();

    registerClosesIdentityArtifactRuntimesArtifactStartup();
  });
});
