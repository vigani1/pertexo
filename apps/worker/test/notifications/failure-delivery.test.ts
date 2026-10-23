import { describe } from 'vitest';

import { registerClassifiesPreFenceSDestinationStore } from './failure-delivery/classifies-pre-fence-sdestination-store.cases.js';
import { registerClassifiesMalformedSCredentialsBeforeProvider } from './failure-delivery/classifies-malformed-scredentials-before-provider.cases.js';
import { registerBindsEveryResendDispatchIdentityField } from './failure-delivery/binds-every-resend-dispatch-identity-field.cases.js';
import { registerClassifiesSlackSWithoutUnsafeAmbiguous } from './failure-delivery/classifies-slack-swithout-unsafe-ambiguous.cases.js';
import { registerPinsRemainingEmailProviderResultPolicy } from './failure-delivery/pins-remaining-email-provider-result-policy.cases.js';
describe('provider failure notification delivery', () => {
  registerClassifiesPreFenceSDestinationStore();

  registerClassifiesMalformedSCredentialsBeforeProvider();

  registerBindsEveryResendDispatchIdentityField();

  registerClassifiesSlackSWithoutUnsafeAmbiguous();

  registerPinsRemainingEmailProviderResultPolicy();
});
