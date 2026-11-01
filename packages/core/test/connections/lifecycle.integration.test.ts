import { describe } from 'vitest';

import { registerFailsClosedOnImpossibleRetained } from './lifecycle/fails-closed-on-impossible-retained.cases.js';
import { registerCreatesResolvesFencesRotatesAudits } from './lifecycle/creates-resolves-fences-rotates-audits.cases.js';
import { registerUsesCompareSwapRotationRejects } from './lifecycle/uses-compare-swap-rotation-rejects.cases.js';
describe('connection lifecycle persistence', () => {
  registerFailsClosedOnImpossibleRetained();

  registerCreatesResolvesFencesRotatesAudits();

  registerUsesCompareSwapRotationRejects();
});
