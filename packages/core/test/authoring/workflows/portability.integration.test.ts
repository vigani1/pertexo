import { afterEach, describe } from 'vitest';

import { afterEachFixture1 } from './portability/fixture.js';
import { registerStoresCuratedTemplateOriginImport } from './portability/stores-curated-template-origin-import.cases.js';
import { registerExportsExactReviewedSavedSource } from './portability/exports-exact-reviewed-saved-source.cases.js';
import { registerPreservesNestedGraphIdentityExpressions } from './portability/preserves-nested-graph-identity-expressions.cases.js';
import { registerHoldsOrderedAuthorityCatalogLocks } from './portability/holds-ordered-authority-catalog-locks.cases.js';
import { registerSerializesConnectionRevocationBothOrders } from './portability/serializes-connection-revocation-both-orders.cases.js';
import { registerAnswersExactRetryExpiredReceipt } from './portability/answers-exact-retry-expired-receipt.cases.js';
afterEach(afterEachFixture1);
describe('portable workflow persistence under the API role', () => {
  registerStoresCuratedTemplateOriginImport();

  registerExportsExactReviewedSavedSource();

  registerPreservesNestedGraphIdentityExpressions();

  registerHoldsOrderedAuthorityCatalogLocks();

  registerSerializesConnectionRevocationBothOrders();

  registerAnswersExactRetryExpiredReceipt();
});
