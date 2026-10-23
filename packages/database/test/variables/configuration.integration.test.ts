import { afterAll, beforeAll } from 'vitest';

import {
  beforeAllFixture1,
  afterAllFixture2,
} from './configuration/fixture.js';
import { registerStoresTypedCurrentValuesOnce } from './configuration/stores-typed-current-values-once.cases.js';
import { registerCapturesCoherentSetAfterConcurrent } from './configuration/captures-coherent-set-after-concurrent.cases.js';
import { registerBoundsNoMatchExpressionScan } from './configuration/bounds-no-match-expression-scan.cases.js';
beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);
registerStoresTypedCurrentValuesOnce();
registerCapturesCoherentSetAfterConcurrent();
registerBoundsNoMatchExpressionScan();
