import { afterAll, beforeAll, describe } from 'vitest';

import { beforeAllFixture1, afterAllFixture2 } from './input-cases/fixture.js';
import { registerListsMetadataGetsDetachedCanonical } from './input-cases/lists-metadata-gets-detached-canonical.cases.js';
import { registerRejectsBoundsCyclesPostgreSQLInvalid } from './input-cases/rejects-bounds-cycles-postgre-sqlinvalid.cases.js';
import { registerRemovesExpiredReceiptsRejectionsSo } from './input-cases/removes-expired-receipts-rejections-so.cases.js';
beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);
describe('bounded version-contextual run-input cases', () => {
  registerListsMetadataGetsDetachedCanonical();

  registerRejectsBoundsCyclesPostgreSQLInvalid();

  registerRemovesExpiredReceiptsRejectionsSo();
});
