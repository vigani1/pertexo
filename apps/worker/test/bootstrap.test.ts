import { describe } from 'vitest';

import { registerForwardsWorkspaceTransactionIdentityOptionsWithout } from './bootstrap/forwards-workspace-transaction-identity-options-without.cases.js';
import { registerSharesOneApplicationCloseSettlementCloses } from './bootstrap/shares-one-application-close-settlement-closes.cases.js';
describe('worker application bootstrap', () => {
  registerForwardsWorkspaceTransactionIdentityOptionsWithout();

  registerSharesOneApplicationCloseSettlementCloses();
});
