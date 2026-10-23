import { afterAll, beforeAll, describe } from 'vitest';

import { beforeAllFixture1, afterAllFixture2 } from './threads/fixture.js';
import { registerAcceptsReviewedFoldCommandsAt } from './threads/accepts-reviewed-fold-commands-at.cases.js';
import { registerKeepsThreadUnreadFailuresReader } from './threads/keeps-thread-unread-failures-reader.cases.js';
import { registerExpiresIdleThreadsReads } from './threads/expires-idle-threads-reads.cases.js';
beforeAll(beforeAllFixture1, 60_000);
afterAll(afterAllFixture2);
describe('workspace inbox threads (ADR 055)', () => {
  registerAcceptsReviewedFoldCommandsAt();

  registerKeepsThreadUnreadFailuresReader();

  registerExpiresIdleThreadsReads();
});
