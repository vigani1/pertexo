import { describe } from 'vitest';

import { registerAcceptsTypedApplicationCommandsAllSeven } from './destinations/accepts-typed-application-commands-all-seven.cases.js';
import { registerRejectsInvalidDuplicateIdempotencyHeaderValues } from './destinations/rejects-invalid-duplicate-idempotency-header-values.cases.js';
import { registerAppendsVersionPropagatesOptimisticIdempotencyConflicts } from './destinations/appends-version-propagates-optimistic-idempotency-conflicts.cases.js';
describe('failure notification destination API seams', () => {
  registerAcceptsTypedApplicationCommandsAllSeven();

  registerRejectsInvalidDuplicateIdempotencyHeaderValues();

  registerAppendsVersionPropagatesOptimisticIdempotencyConflicts();
});
