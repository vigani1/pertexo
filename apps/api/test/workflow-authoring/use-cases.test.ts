import { describe } from 'vitest';

import { registerReadsAuthoritativeHistoricalOriginThroughOpt } from './use-cases/reads-authoritative-historical-origin-through-opt.cases.js';
import { registerRejectsMalformedVersionRestoreBodyJ } from './use-cases/rejects-malformed-version-restore-body-j.cases.js';
import { registerWorkflowAuthoringApplicationSeamsDeniesRenameJ } from './use-cases/workflow-authoring-application-seams-denies-rename-j.cases.js';
import { registerPassesOpaquePublishTagPersistenceWithout } from './use-cases/passes-opaque-publish-tag-persistence-without.cases.js';
import { registerUsesNamedReadCapabilityListValidate } from './use-cases/uses-named-read-capability-list-validate.cases.js';
import { registerKeepsRecentlyUpdatedCursorsDistinctCreated } from './use-cases/keeps-recently-updated-cursors-distinct-created.cases.js';
import { registerProjectsOneCreateCommandReturnedWorkflow } from './use-cases/projects-one-create-command-returned-workflow.cases.js';
describe('workflow authoring application seams', () => {
  registerReadsAuthoritativeHistoricalOriginThroughOpt();

  registerRejectsMalformedVersionRestoreBodyJ();

  registerWorkflowAuthoringApplicationSeamsDeniesRenameJ();

  registerPassesOpaquePublishTagPersistenceWithout();

  registerUsesNamedReadCapabilityListValidate();

  registerKeepsRecentlyUpdatedCursorsDistinctCreated();

  registerProjectsOneCreateCommandReturnedWorkflow();
});
