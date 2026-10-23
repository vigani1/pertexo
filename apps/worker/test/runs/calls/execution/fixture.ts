import { describe } from 'vitest';

import { fixture } from '../fixtures.js';

export const describeIntegration = fixture.enabled ? describe : describe.skip;
