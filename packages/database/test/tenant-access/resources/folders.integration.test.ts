import { afterAll, beforeAll } from 'vitest';

import { beforeAllFixture1, afterAllFixture2 } from './folders/fixture.js';
import { registerOmitsInaccessibleWorkflowsRetainedRun } from './folders/omits-inaccessible-workflows-retained-run.cases.js';
import { registerFencesGrantEditsAudienceReviews } from './folders/fences-grant-edits-audience-reviews.cases.js';
import { registerChecksRetainedFileOwnersBefore } from './folders/checks-retained-file-owners-before.cases.js';
import { registerOmitsHiddenWorkflowIdentitiesVariable } from './folders/omits-hidden-workflow-identities-variable.cases.js';
import { registerKeepsRetainedRunReadsAvailable } from './folders/keeps-retained-run-reads-available.cases.js';
import { registerRefusesUnlinkedOrganizationGroups } from './folders/refuses-unlinked-organization-groups.cases.js';
beforeAll(beforeAllFixture1, 30_000);
afterAll(afterAllFixture2);
registerOmitsInaccessibleWorkflowsRetainedRun();
registerFencesGrantEditsAudienceReviews();
registerChecksRetainedFileOwnersBefore();
registerRefusesUnlinkedOrganizationGroups();
registerOmitsHiddenWorkflowIdentitiesVariable();
registerKeepsRetainedRunReadsAvailable();
