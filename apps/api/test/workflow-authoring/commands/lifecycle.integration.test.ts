import { afterEach, beforeEach } from 'vitest';

import {
  describeIntegration,
  resetAuthenticatedWorkflowLifecycleHTTPCommandsFixture,
  cleanAuthenticatedWorkflowLifecycleHTTPCommandsFixture,
} from './lifecycle/fixture.js';
import { registerRequiresAuthenticationCSRFEachLifecycleCommand } from './lifecycle/requires-authentication-csrfeach-lifecycle-command.cases.js';
import { registerArchivesRestoresUnpublishedWorkflowExactConcurrent } from './lifecycle/archives-restores-unpublished-workflow-exact-concurrent.cases.js';
import { registerArchivesRestoresPublishedWorkflowWithoutChanging } from './lifecycle/archives-restores-published-workflow-without-changing.cases.js';
import { registerInactiveWorkspaceDenials } from './lifecycle/inactive-workspace-denials.cases.js';
describeIntegration('authenticated workflow lifecycle HTTP commands', () => {
  beforeEach(resetAuthenticatedWorkflowLifecycleHTTPCommandsFixture);

  afterEach(cleanAuthenticatedWorkflowLifecycleHTTPCommandsFixture);
  registerRequiresAuthenticationCSRFEachLifecycleCommand();

  registerInactiveWorkspaceDenials();
  registerArchivesRestoresUnpublishedWorkflowExactConcurrent();

  registerArchivesRestoresPublishedWorkflowWithoutChanging();
});
