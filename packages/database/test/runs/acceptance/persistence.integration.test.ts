import { describe } from 'vitest';

import { installExecutionAcceptanceFixture } from './fixtures.js';
import { registerValidatesFreshCallableInputAfter } from './persistence/validates-fresh-callable-input-after.cases.js';
import { registerPersistsCanonicalInputWithoutInherited } from './persistence/persists-canonical-input-without-inherited.cases.js';
import { registerSerializesConcurrentExactRetriesOne } from './persistence/serializes-concurrent-exact-retries-one.cases.js';
installExecutionAcceptanceFixture();
describe('workflow run acceptance persistence and idempotency', () => {
  registerValidatesFreshCallableInputAfter();

  registerPersistsCanonicalInputWithoutInherited();

  registerSerializesConcurrentExactRetriesOne();
});
