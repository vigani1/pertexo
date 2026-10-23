import { beforeAll, afterAll } from 'vitest';

import {
  beforeAllFixture1,
  afterAllFixture2,
} from './publication-review/fixture.js';
import { registerBlocksOrdinaryPublicationThenPublishes } from './publication-review/blocks-ordinary-publication-then-publishes.cases.js';
import { registerUsesSharedInboxAudiencePersonal } from './publication-review/uses-shared-inbox-audience-personal.cases.js';
import { registerBoundsWorkspace100PendingReviews } from './publication-review/bounds-workspace100-pending-reviews.cases.js';
beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);
registerBlocksOrdinaryPublicationThenPublishes();
registerUsesSharedInboxAudiencePersonal();
registerBoundsWorkspace100PendingReviews();
