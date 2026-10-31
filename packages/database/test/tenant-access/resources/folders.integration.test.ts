import { afterAll, beforeAll } from 'vitest';

import { beforeAllFixture1, afterAllFixture2 } from './folders/fixture.js';
import { registerOmitsInaccessibleWorkflowsRetainedRun } from './folders/omits-inaccessible-workflows-retained-run.cases.js';
import { registerFencesGrantEditsAudienceReviews } from './folders/fences-grant-edits-audience-reviews.cases.js';
import { registerChecksRetainedFileOwnersBefore } from './folders/checks-retained-file-owners-before.cases.js';
import { registerCallTargetsAndPrivateChildren } from './folders/call-targets-and-private-children.cases.js';
import { registerKeepsRetainedRunReadsAvailable } from './folders/keeps-retained-run-reads-available.cases.js';
import { registerRefusesUnlinkedOrganizationGroups } from './folders/refuses-unlinked-organization-groups.cases.js';
import { registerReplacesFolderGrantLists } from './folders/replaces-folder-grant-lists.cases.js';
beforeAll(beforeAllFixture1, 30_000);
afterAll(afterAllFixture2);
registerOmitsInaccessibleWorkflowsRetainedRun();
registerFencesGrantEditsAudienceReviews();
registerChecksRetainedFileOwnersBefore();
registerRefusesUnlinkedOrganizationGroups();
registerReplacesFolderGrantLists();
registerCallTargetsAndPrivateChildren();
registerKeepsRetainedRunReadsAvailable();
