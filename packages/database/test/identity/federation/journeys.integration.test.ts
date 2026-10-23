import { describe } from 'vitest';

import { registerBoundsAttachedMethodsRollsBack } from './journeys/bounds-attached-methods-rolls-back.cases.js';
import { registerNeverTakesOverUnverifiedExisting } from './journeys/never-takes-over-unverified-existing.cases.js';
describe('durable organization sign-in', () => {
  registerBoundsAttachedMethodsRollsBack();

  registerNeverTakesOverUnverifiedExisting();
});
