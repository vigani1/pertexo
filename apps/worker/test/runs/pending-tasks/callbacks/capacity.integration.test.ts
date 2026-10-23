import { afterAll, beforeAll, describe } from 'vitest';

import { fixture } from '../../calls/fixtures.js';

import { registerPausesNestedCallChainInsideOne } from './capacity/pauses-nested-call-chain-inside-one.cases.js';
import { registerRevokesUnusedPreparedWaitAfterBranch } from './capacity/revokes-unused-prepared-wait-after-branch.cases.js';
describe.runIf(fixture.enabled)(
  'Callback waits in structured work and shared Call slots',
  () => {
    beforeAll(fixture.setup, 60_000);
    afterAll(fixture.restoreServicesAndClose);
    registerPausesNestedCallChainInsideOne();

    registerRevokesUnusedPreparedWaitAfterBranch();
  },
);
