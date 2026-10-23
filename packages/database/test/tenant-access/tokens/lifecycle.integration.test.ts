import { afterAll, beforeAll, describe } from 'vitest';

import { beforeAllFixture1, afterAllFixture2 } from './lifecycle/fixture.js';
import { registerRevealsSecretOnceStoresHash } from './lifecycle/reveals-secret-once-stores-hash.cases.js';
import { registerPurgesTokensBeforeOwningMemberships } from './lifecycle/purges-tokens-before-owning-memberships.cases.js';
beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);
describe('persisted personal API tokens', () => {
  registerRevealsSecretOnceStoresHash();

  registerPurgesTokensBeforeOwningMemberships();
});
