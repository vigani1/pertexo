import { afterAll, beforeAll, beforeEach, describe } from 'vitest';

import {
  resetFixture,
  beforeAllFixture1,
  afterAllFixture2,
} from './api/fixture.js';
import { registerCountsFilteredRowsPlanWork } from './api/counts-filtered-rows-plan-work.cases.js';
import { registerRecordsProductionShapedNameFilter } from './api/records-production-shaped-name-filter.cases.js';
import { registerRecoversAcceptedCheckedDuplicateRequests } from './api/recovers-accepted-checked-duplicate-requests.cases.js';
import { registerReportsVersionConflictPublicationCommits } from './api/reports-version-conflict-publication-commits.cases.js';
import { registerDistinguishesExactConflictingAbsentReason } from './api/distinguishes-exact-conflicting-absent-reason.cases.js';
import { registerReplaysAgainstExplicitlySelectedRetained } from './api/replays-against-explicitly-selected-retained.cases.js';
import { registerKeepsReplayLocksBehindOwner } from './api/keeps-replay-locks-behind-owner.cases.js';
import { registerReadsNodeRunOutputThrough } from './api/reads-node-run-output-through.cases.js';
import { registerReadsEachStepAcrossWorkflow } from './api/reads-each-step-across-workflow.cases.js';
beforeAll(beforeAllFixture1);
beforeEach(resetFixture);
afterAll(afterAllFixture2);
describe('workflow run API persistence', () => {
  registerCountsFilteredRowsPlanWork();

  registerRecordsProductionShapedNameFilter();

  registerRecoversAcceptedCheckedDuplicateRequests();

  registerReportsVersionConflictPublicationCommits();

  registerDistinguishesExactConflictingAbsentReason();

  registerReplaysAgainstExplicitlySelectedRetained();

  registerKeepsReplayLocksBehindOwner();

  registerReadsNodeRunOutputThrough();

  registerReadsEachStepAcrossWorkflow();
});
