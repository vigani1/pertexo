import { afterAll, beforeAll } from 'vitest';

import {
  prepareDeliveryIntegrationTestTsFixture,
  closeDeliveryIntegrationTestTsFixture,
} from './delivery/fixture.js';
import { registerDeliversAPISealedCommandThroughReal } from './delivery/delivers-apisealed-command-through-real.cases.js';
import { registerDeliversRealPersonalNoticeMailRefuses } from './delivery/delivers-real-personal-notice-mail-refuses.cases.js';
import { registerOpensDataFromBeforeTheSecretsMove } from './delivery/opens-data-from-before-the-secrets-move.cases.js';
beforeAll(prepareDeliveryIntegrationTestTsFixture, 60_000);
afterAll(closeDeliveryIntegrationTestTsFixture, 30_000);
registerDeliversAPISealedCommandThroughReal();
registerDeliversRealPersonalNoticeMailRefuses();
registerOpensDataFromBeforeTheSecretsMove();
