import { afterAll, beforeAll, beforeEach, describe } from 'vitest';

import {
  beforeAllFixture1,
  beforeEachFixture2,
  afterAllFixture3,
} from './metadata-lifecycle/fixture.js';
import { registerForcesRLSWithholdsDestructiveTable } from './metadata-lifecycle/forces-rlswithholds-destructive-table.cases.js';
import { registerRejectsLateFinalizeAfterPending } from './metadata-lifecycle/rejects-late-finalize-after-pending.cases.js';
beforeAll(beforeAllFixture1);
beforeEach(beforeEachFixture2);
afterAll(afterAllFixture3);
describe('artifact metadata lifecycle', () => {
  registerForcesRLSWithholdsDestructiveTable();

  registerRejectsLateFinalizeAfterPending();
});
