import { afterEach, describe } from 'vitest';

import { cleanConnectionsRealNestHTTPStackFixture } from './http-stack/fixture.js';
import { registerGuardsSharingRoutesBeforePersistenceValidates } from './http-stack/guards-sharing-routes-before-persistence-validates.cases.js';
import { registerReportsUnavailableWebhooksAfterAuthenticationWorkspace } from './http-stack/reports-unavailable-webhooks-after-authentication-workspace.cases.js';
import { registerReadsWorkflowFailureAlertPolicyBuilder } from './http-stack/reads-workflow-failure-alert-policy-builder.cases.js';
import { registerKeepsUsageNondisclosingAcrossAuthenticationWorkspace } from './http-stack/keeps-usage-nondisclosing-across-authentication-workspace.cases.js';
describe('connections real Nest HTTP stack', () => {
  afterEach(cleanConnectionsRealNestHTTPStackFixture);
  registerGuardsSharingRoutesBeforePersistenceValidates();

  registerReportsUnavailableWebhooksAfterAuthenticationWorkspace();

  registerReadsWorkflowFailureAlertPolicyBuilder();

  registerKeepsUsageNondisclosingAcrossAuthenticationWorkspace();
});
