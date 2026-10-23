import { afterAll, beforeAll, describe } from 'vitest';

import { organizationFixtureEnabled } from './owned.fixture.js';

import {
  beforeAllFixture1,
  afterAllFixture2,
} from './folders-batch/fixture.js';
import { registerKeepsSiblingNamesUniqueRegardless } from './folders-batch/keeps-sibling-names-unique-regardless.cases.js';
import { registerAppliesItemOnceSameBatch } from './folders-batch/applies-item-once-same-batch.cases.js';
describe.skipIf(!organizationFixtureEnabled)(
  'owned folders and organization batches',
  () => {
    beforeAll(beforeAllFixture1, 60_000);
    afterAll(afterAllFixture2);
    registerKeepsSiblingNamesUniqueRegardless();

    registerAppliesItemOnceSameBatch();
  },
);
