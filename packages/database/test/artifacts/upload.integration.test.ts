import { afterAll, afterEach, beforeAll, beforeEach, describe } from 'vitest';

import {
  beforeAllFixture1,
  beforeEachFixture2,
  afterEachFixture3,
  afterAllFixture4,
} from './upload/fixture.js';
import { registerRejectsHTTPUnsafeMediaType } from './upload/rejects-httpunsafe-media-type.cases.js';
import { registerAppliesSharedCapabilityPolicyArtifact } from './upload/applies-shared-capability-policy-artifact.cases.js';
import { registerFinalizesExactMetadataSupportsNested } from './upload/finalizes-exact-metadata-supports-nested.cases.js';
import { registerRejectsFinalizationAfterExpiryDuring } from './upload/rejects-finalization-after-expiry-during.cases.js';
import { registerCancelsBlockedFinalization } from './upload/cancels-blocked-finalization.cases.js';
beforeAll(beforeAllFixture1);
beforeEach(beforeEachFixture2);
afterEach(afterEachFixture3);
afterAll(afterAllFixture4);
describe('artifact upload database authority', () => {
  registerRejectsHTTPUnsafeMediaType();

  registerAppliesSharedCapabilityPolicyArtifact();

  registerFinalizesExactMetadataSupportsNested();

  registerRejectsFinalizationAfterExpiryDuring();

  registerCancelsBlockedFinalization();
});
