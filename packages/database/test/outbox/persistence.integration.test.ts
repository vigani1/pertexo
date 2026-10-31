import { afterAll, beforeAll, beforeEach, describe } from 'vitest';

import { transport } from './persistence/fixture.js';
import { registerInsertsTransactionScopeHidesRow } from './persistence/inserts-transaction-scope-hides-row.cases.js';
import { registerRecoversAtomicInboxOutcomeAfter } from './persistence/recovers-atomic-inbox-outcome-after.cases.js';
import { registerClaimsBoundedDisjointBatchesChanges } from './persistence/claims-bounded-disjoint-batches-changes.cases.js';
import { registerKeepsDisabledJobKindsDurable } from './persistence/keeps-disabled-job-kinds-durable.cases.js';
import { registerAllowsDispatcherLifecycleMutationsBut } from './persistence/allows-dispatcher-lifecycle-mutations-but.cases.js';
import { registerRedispatchesOneFailedRowWithout } from './persistence/redispatches-one-failed-row-without.cases.js';
import { registerSettlesOverdueDeliveries } from './persistence/settles-overdue-deliveries.cases.js';
beforeAll(transport.initialize);
beforeEach(transport.reset);
afterAll(transport.close);
describe('transactional outbox persistence', () => {
  registerInsertsTransactionScopeHidesRow();

  registerRecoversAtomicInboxOutcomeAfter();

  registerClaimsBoundedDisjointBatchesChanges();

  registerKeepsDisabledJobKindsDurable();

  registerAllowsDispatcherLifecycleMutationsBut();

  registerRedispatchesOneFailedRowWithout();

  registerSettlesOverdueDeliveries();
});
