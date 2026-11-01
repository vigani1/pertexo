import { afterAll, beforeAll, describe } from 'vitest';

import { beforeAllFixture1, afterAllFixture2 } from './webhooks/fixture.js';
import { registerRejectsInvalidReconciliationInputMessage } from './webhooks/reconciliation/rejects-invalid-reconciliation-input-message.cases.js';
import { registerBindsEveryWebhookMutationReplay } from './webhooks/reconciliation/binds-every-webhook-mutation-replay.cases.js';
import { registerAppliesArchiveStateAtReconciliation } from './webhooks/reconciliation/applies-archive-state-at-reconciliation.cases.js';
import { registerRestoresActiveResourcesPreservingExplicit } from './webhooks/reconciliation/restores-active-resources-preserving-explicit.cases.js';
import { registerProjectsPartialGlobalArchivedFailures } from './webhooks/reconciliation/projects-partial-global-archived-failures.cases.js';
import { registerCommitsOneSkippedWebhookEvent } from './webhooks/ingress/commits-one-skipped-webhook-event.cases.js';
import { registerRefusesNewTriggerWorkWorkflow } from './webhooks/ingress/refuses-new-trigger-work-workflow.cases.js';
import { registerPreparesFreshInputCoordinationReplay } from './webhooks/ingress/prepares-fresh-input-coordination-replay.cases.js';
import { registerKeepsGraphDisabledTriggerNodes } from './webhooks/ingress/keeps-graph-disabled-trigger-nodes.cases.js';
import { registerInvalidatesOldEndpointReferencesAt } from './webhooks/ingress/invalidates-old-endpoint-references-at.cases.js';
import { registerRecordsMetadataDeliveryOutcomesPages } from './webhooks/ingress/records-metadata-delivery-outcomes-pages.cases.js';
import { registerSaysWebhookAlreadyHasEndpoint } from './webhooks/ingress/says-webhook-already-has-endpoint.cases.js';
import { registerKeepsOtherWorkServedDuringBurst } from './webhooks/ingress/keeps-other-work-served-during-burst.cases.js';
import { registerRefusesDeliveryOutOfTime } from './webhooks/ingress/refuses-delivery-out-of-time.cases.js';
beforeAll(beforeAllFixture1, 60_000);
afterAll(afterAllFixture2);
describe('generic webhook database seam', () => {
  registerRejectsInvalidReconciliationInputMessage();

  registerBindsEveryWebhookMutationReplay();

  registerAppliesArchiveStateAtReconciliation();

  registerRestoresActiveResourcesPreservingExplicit();

  registerProjectsPartialGlobalArchivedFailures();

  registerCommitsOneSkippedWebhookEvent();

  registerRefusesNewTriggerWorkWorkflow();

  registerPreparesFreshInputCoordinationReplay();

  registerKeepsGraphDisabledTriggerNodes();

  registerInvalidatesOldEndpointReferencesAt();

  registerRecordsMetadataDeliveryOutcomesPages();

  registerSaysWebhookAlreadyHasEndpoint();

  registerKeepsOtherWorkServedDuringBurst();

  registerRefusesDeliveryOutOfTime();
});
