import { describe } from 'vitest';

import { fixture } from './calls.fixture.js';

export const describeIntegration = fixture.enabled ? describe : describe.skip;
