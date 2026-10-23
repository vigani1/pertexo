import { describe } from 'vitest';

import { registerPrunesExpiredWebhookCapturesPages } from './transient-data-retention/prunes-expired-webhook-captures-pages.cases.js';
import { registerExpiresUnansweredInvitationsRemovesEnded } from './transient-data-retention/expires-unanswered-invitations-removes-ended.cases.js';
import { registerObservesLineageBoundaryIClaim } from './transient-data-retention/observes-lineage-boundary-iclaim.cases.js';
describe('transient data retention', () => {
  registerPrunesExpiredWebhookCapturesPages();

  registerExpiresUnansweredInvitationsRemovesEnded();

  registerObservesLineageBoundaryIClaim();
});
