import { afterAll, beforeAll, describe } from 'vitest';

import { fixture } from '../calls/fixtures.js';
import { registerUsesDestinationCredentialsVariablesTableRows } from './execution/uses-destination-credentials-variables-table-rows.cases.js';
describe.runIf(fixture.enabled)(
  'promoted definitions on the real worker',
  () => {
    beforeAll(fixture.setup, 60000);
    afterAll(fixture.restoreServicesAndClose);
    registerUsesDestinationCredentialsVariablesTableRows();
  },
);
