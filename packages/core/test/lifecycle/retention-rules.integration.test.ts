import { afterAll, beforeAll, describe } from 'vitest';

import {
  beforeAllFixture1,
  afterAllFixture2,
} from './retention-rules/fixture.js';
import { registerRemovesSignProofRowsDay } from './retention-rules/removes-sign-proof-rows-day.cases.js';
import { registerSkipsLockedExpiredAuditRows } from './retention-rules/skips-locked-expired-audit-rows.cases.js';
import { registerDoesNotDeleteWarningReactivated } from './retention-rules/does-not-delete-warning-reactivated.cases.js';
beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);
describe('retention rules', () => {
  registerRemovesSignProofRowsDay();

  registerSkipsLockedExpiredAuditRows();

  registerDoesNotDeleteWarningReactivated();
});
