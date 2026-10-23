import { describe } from 'vitest';

import { registerIdempotentlyManagesImmutableFailureNotification } from './persistence/idempotently-manages-immutable-failure-notification.cases.js';
import { registerEnforcesDestinationCapabilitiesActiveAuthority } from './persistence/enforces-destination-capabilities-active-authority.cases.js';
import { registerAdmitsExactlyOneOptimisticDestination } from './persistence/admits-exactly-one-optimistic-destination.cases.js';
describe('connection persistence', () => {
  registerIdempotentlyManagesImmutableFailureNotification();

  registerEnforcesDestinationCapabilitiesActiveAuthority();

  registerAdmitsExactlyOneOptimisticDestination();
});
