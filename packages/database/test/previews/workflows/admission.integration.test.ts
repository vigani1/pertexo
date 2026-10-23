import { afterAll, beforeAll, describe } from 'vitest';

import { beforeAllFixture1, afterAllFixture2 } from './admission/fixture.js';
import { registerFreezesUnpublishedDraftWithoutCreating } from './admission/freezes-unpublished-draft-without-creating.cases.js';
import { registerRequiresAcknowledgementExactCurrentEffectful } from './admission/requires-acknowledgement-exact-current-effectful.cases.js';
import { registerPurgesFrozenTestPayloadsWorkspace } from './admission/purges-frozen-test-payloads-workspace.cases.js';
beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);
describe('whole-draft test admission', () => {
  registerFreezesUnpublishedDraftWithoutCreating();

  registerRequiresAcknowledgementExactCurrentEffectful();

  registerPurgesFrozenTestPayloadsWorkspace();
});
