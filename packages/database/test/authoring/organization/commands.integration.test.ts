import { afterAll, beforeAll, describe } from 'vitest';
import { organizationFixtureEnabled } from './owned.fixture.js';

import { beforeAllFixture1, afterAllFixture2 } from './commands/fixture.js';
import { registerNormalizesExactASCIICommandIdentity } from './commands/normalizes-exact-asciicommand-identity.cases.js';
import { registerChecksCurrentRolesOnProcessing } from './commands/checks-current-roles-on-processing.cases.js';
describe.skipIf(!organizationFixtureEnabled)(
  'owned PostgreSQL organization commands',
  () => {
    beforeAll(beforeAllFixture1, 120000);
    afterAll(afterAllFixture2, 30000);
    registerNormalizesExactASCIICommandIdentity();

    registerChecksCurrentRolesOnProcessing();
  },
);
