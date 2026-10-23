import { afterAll, beforeAll } from 'vitest';

import { beforeAllFixture1, afterAllFixture2 } from './comments/fixture.js';
import { registerLetsReaderCreateRetryDiscussion } from './comments/lets-reader-create-retry-discussion.cases.js';
import { registerKeepsRemovedStepDiscussionExcludes } from './comments/keeps-removed-step-discussion-excludes.cases.js';
import { registerPurgesDiscussionRowsExplicitlyLeaves } from './comments/purges-discussion-rows-explicitly-leaves.cases.js';
beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);
registerLetsReaderCreateRetryDiscussion();
registerKeepsRemovedStepDiscussionExcludes();
registerPurgesDiscussionRowsExplicitlyLeaves();
