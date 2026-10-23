import { afterAll, beforeAll, describe } from 'vitest';

import { beforeAllFixture1, afterAllFixture2 } from './capacity/fixture.js';
import { registerLendsOneSlotKeepsTerminal } from './capacity/lends-one-slot-keeps-terminal.cases.js';
import { registerKeepsLendingParentSWorkflow } from './capacity/keeps-lending-parent-sworkflow.cases.js';
import { registerReturnsCapacityWithoutAcquiringLock } from './capacity/returns-capacity-without-acquiring-lock.cases.js';
beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);
describe('Call workspace slot transfer', () => {
  registerLendsOneSlotKeepsTerminal();

  registerKeepsLendingParentSWorkflow();

  registerReturnsCapacityWithoutAcquiringLock();
});
