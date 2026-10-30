import { describe } from 'vitest';

import { enabled } from './real-api/environment.js';
import { createWorkspaceApiFixture } from './real-api/fixture.js';
import { registerAuthorsPublishesWorkflowThroughRealAuthRLS } from './real-api/cases/publication.cases.js';
import { registerStartsReplaysReadsCancelsStreamsDurableWorkflow } from './real-api/cases/run-lifecycle.cases.js';
import { registerEnforcesCSRFAtomicallyCreatesOwnerMembershipCorrelated } from './real-api/cases/workspace-creation.cases.js';
import { registerConditionallyRenamesWorkspaceSafelyReconcilesLostAcknowledgements } from './real-api/cases/workspace-lifecycle.cases.js';
import { registerReactivatesSuspendedWorkspace } from './real-api/cases/workspace-reactivation.cases.js';
import { registerServesPrivateCurrentUserProjectionBoundedAuthorized } from './real-api/cases/member-projections.cases.js';
import { registerAcceptsDeliveredInvitationOnceRotatesRecipientSession } from './real-api/cases/invitations.cases.js';
describe.runIf(enabled)('Phase 1 real PostgreSQL API identity slice', () => {
  const caseFixture = createWorkspaceApiFixture();
  registerAuthorsPublishesWorkflowThroughRealAuthRLS(caseFixture);
  registerStartsReplaysReadsCancelsStreamsDurableWorkflow(caseFixture);
  registerEnforcesCSRFAtomicallyCreatesOwnerMembershipCorrelated(caseFixture);
  registerConditionallyRenamesWorkspaceSafelyReconcilesLostAcknowledgements(
    caseFixture,
  );
  registerReactivatesSuspendedWorkspace(caseFixture);
  registerServesPrivateCurrentUserProjectionBoundedAuthorized(caseFixture);
  registerAcceptsDeliveredInvitationOnceRotatesRecipientSession(caseFixture);
});
