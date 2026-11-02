import { afterAll, beforeAll, describe } from 'vitest';

import { assertIntegrationGateConfigured } from '../support/integration-gate.js';

import {
  adminBaseUrl,
  migrationBaseUrl,
  apiBaseUrl,
  requested,
  enabled,
  prepareDirectWebhookHTTPIntegrationFixture,
  closeDirectWebhookHTTPIntegrationFixture,
} from './direct-webhook/fixture.js';
import { registerCapturesOneRealTestEventBefore } from './direct-webhook/captures-one-real-test-event-before.cases.js';
import { registerConfiguresModesThroughAuthenticatedHTTPQualifies } from './direct-webhook/configures-modes-through-authenticated-httpqualifies.cases.js';
import { registerProvesAtomicAcceptanceExactReplayReplay } from './direct-webhook/proves-atomic-acceptance-exact-replay-replay.cases.js';
import { registerReadsResumedRunRunningThroughAuthenticated } from './direct-webhook/reads-resumed-run-running-through-authenticated.cases.js';
import { registerRefusesWebhooksOutsideActiveWorkspace } from './direct-webhook/refuses-webhooks-outside-active-workspace.cases.js';
import { registerReturnsNoEndpointCredentialOnCompleted } from './direct-webhook/returns-no-endpoint-credential-on-completed.cases.js';
import { registerNoSilentDedupe } from './direct-webhook/no-silent-dedupe.cases.js';
import { registerClosedDoors } from './direct-webhook/doors/closed.cases.js';
import { registerSignatures } from './direct-webhook/doors/signatures.cases.js';
import { registerBurstQueue } from './direct-webhook/doors/burst.cases.js';
import { registerRefusedBodies } from './direct-webhook/doors/bodies.cases.js';
import { registerKeepsSenderWordsOutOfLogs } from './direct-webhook/sender-words-in-logs.cases.js';
import {
  registerStoresKeysAsHashes,
  registerSurvivesPublish,
} from './direct-webhook/survives-publish.cases.js';
assertIntegrationGateConfigured({
  name: 'direct webhook HTTP integration',
  requested,
  required: {
    DATABASE_ADMIN_URL: adminBaseUrl,
    DATABASE_MIGRATION_URL: migrationBaseUrl,
    DATABASE_URL: apiBaseUrl,
  },
});
if (requested)
  console.info(
    '[integration-gate] direct webhook HTTP integration requested and configured; executing the required HTTP assertion',
  );
describe.runIf(enabled)('direct webhook HTTP integration', () => {
  beforeAll(prepareDirectWebhookHTTPIntegrationFixture, 120_000);

  afterAll(closeDirectWebhookHTTPIntegrationFixture, 30_000);
  registerCapturesOneRealTestEventBefore();

  registerConfiguresModesThroughAuthenticatedHTTPQualifies();

  registerProvesAtomicAcceptanceExactReplayReplay();

  registerReadsResumedRunRunningThroughAuthenticated();

  registerRefusesWebhooksOutsideActiveWorkspace();

  registerReturnsNoEndpointCredentialOnCompleted();

  registerSurvivesPublish();

  registerStoresKeysAsHashes();

  registerNoSilentDedupe();

  registerClosedDoors();

  registerSignatures();

  registerBurstQueue();

  registerRefusedBodies();

  registerKeepsSenderWordsOutOfLogs();
});
