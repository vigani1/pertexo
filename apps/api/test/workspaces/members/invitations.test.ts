import { describe } from 'vitest';

import { registerMapsUnresolvedDeliveryTruthfulRecoverableProblem } from './invitations/maps-unresolved-delivery-truthful-recoverable-problem.cases.js';
import { registerReturnsSameReplacementSetCookieBrowser } from './invitations/returns-same-replacement-set-cookie-browser.cases.js';
describe('workspace invitation use cases', () => {
  registerMapsUnresolvedDeliveryTruthfulRecoverableProblem();

  registerReturnsSameReplacementSetCookieBrowser();
});
