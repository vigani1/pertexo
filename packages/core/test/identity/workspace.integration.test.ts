import { afterAll, beforeAll, describe } from 'vitest';

import { beforeAllFixture1, afterAllFixture2 } from './workspace/fixture.js';
import { registerShowsExpiredBeforeRetentionRuns } from './workspace/invitations/expiration/shows-expired-before-retention-runs.cases.js';
import { registerReplaysCommandReorderedNestedObject } from './workspace/commands/replays-command-reordered-nested-object.cases.js';
import { registerSerializesConcurrentRenamesAuthorizesAgainst } from './workspace/commands/serializes-concurrent-renames-authorizes-against.cases.js';
import { registerListsActiveWorkspaceMembersBounded } from './workspace/membership/lists-active-workspace-members-bounded.cases.js';
import { registerChangesExistingMemberRoleOnce } from './workspace/membership/changes-existing-member-role-once.cases.js';
import { registerSerializesSameRevisionRoleChanges } from './workspace/membership/serializes-same-revision-role-changes.cases.js';
import { registerForbidsRoleTransitionsOutsidePolicy } from './workspace/membership/forbids-role-transitions-outside-policy.cases.js';
import { registerRollsBackRoleSessionAudit } from './workspace/membership/rolls-back-role-session-audit.cases.js';
import { registerSerializesRoleChangeBehindDeletion } from './workspace/membership/serializes-role-change-behind-deletion.cases.js';
import { registerSerializesDuplicateWorkspaceSlugsLeaves } from './workspace/commands/serializes-duplicate-workspace-slugs-leaves.cases.js';
import { registerBindsInvitationSCommandTarget } from './workspace/invitations/management/binds-invitation-scommand-target.cases.js';
import { registerAuthorizesInvitationsCurrentRolesKeeps } from './workspace/invitations/management/authorizes-invitations-current-roles-keeps.cases.js';
import { registerInvalidatesReplacedBrowserBindingWithout } from './workspace/invitations/bindings/invalidates-replaced-browser-binding-without.cases.js';
import { registerRecoversExactCommittedReplacementRejecting } from './workspace/invitations/bindings/recovers-exact-committed-replacement-rejecting.cases.js';
import { registerReplacesSupersededResendJourneyValid } from './workspace/invitations/bindings/replaces-superseded-resend-journey-valid.cases.js';
import { registerReplacesTerminalSuccessorAcrossWorkspaces } from './workspace/invitations/bindings/replaces-terminal-successor-across-workspaces.cases.js';
import { registerKeepsUnexpiredCompletedSuccessorLive } from './workspace/invitations/bindings/keeps-unexpired-completed-successor-live.cases.js';
import { registerSerializesReplacementClaimCleanupAcceptance } from './workspace/invitations/bindings/serializes-replacement-claim-cleanup-acceptance.cases.js';
import { registerAllowsOneConcurrentReplacementSame } from './workspace/invitations/bindings/allows-one-concurrent-replacement-same.cases.js';
import { registerKeepsInvitationDeliveryRenderingStable } from './workspace/invitations/delivery/keeps-invitation-delivery-rendering-stable.cases.js';
import { registerExpiresSealedAttemptsBeforeReinviting } from './workspace/invitations/expiration/expires-sealed-attempts-before-reinviting.cases.js';
import { registerRetiresEvidenceLeftBehindBy } from './workspace/invitations/expiration/retires-evidence-left-behind-by.cases.js';
import { registerExpiresResolverSelectedInvitationSupersedes } from './workspace/invitations/expiration/expires-resolver-selected-invitation-supersedes.cases.js';
import { registerAcceptsOnceRotatesSessionsAtomically } from './workspace/invitations/acceptance/accepts-once-rotates-sessions-atomically.cases.js';
import { registerMarksOtherAccountProofWrong } from './workspace/invitations/acceptance/marks-other-account-proof-wrong.cases.js';
import { registerRechecksActiveUserStatusUnder } from './workspace/invitations/acceptance/rechecks-active-user-status-under.cases.js';
import { registerSerializesAcceptanceAgainstRevocationSo } from './workspace/invitations/acceptance/serializes-acceptance-against-revocation-so.cases.js';
beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);
describe('identity/workspace persistence', () => {
  registerShowsExpiredBeforeRetentionRuns();

  registerReplaysCommandReorderedNestedObject();

  registerSerializesConcurrentRenamesAuthorizesAgainst();

  registerListsActiveWorkspaceMembersBounded();

  registerChangesExistingMemberRoleOnce();

  registerSerializesSameRevisionRoleChanges();

  registerForbidsRoleTransitionsOutsidePolicy();

  registerRollsBackRoleSessionAudit();

  registerSerializesRoleChangeBehindDeletion();

  registerSerializesDuplicateWorkspaceSlugsLeaves();

  registerBindsInvitationSCommandTarget();

  registerAuthorizesInvitationsCurrentRolesKeeps();

  registerInvalidatesReplacedBrowserBindingWithout();

  registerRecoversExactCommittedReplacementRejecting();

  registerReplacesSupersededResendJourneyValid();

  registerReplacesTerminalSuccessorAcrossWorkspaces();

  registerKeepsUnexpiredCompletedSuccessorLive();

  registerSerializesReplacementClaimCleanupAcceptance();

  registerAllowsOneConcurrentReplacementSame();

  registerKeepsInvitationDeliveryRenderingStable();

  registerExpiresSealedAttemptsBeforeReinviting();

  registerRetiresEvidenceLeftBehindBy();

  registerExpiresResolverSelectedInvitationSupersedes();

  registerAcceptsOnceRotatesSessionsAtomically();

  registerMarksOtherAccountProofWrong();

  registerRechecksActiveUserStatusUnder();

  registerSerializesAcceptanceAgainstRevocationSo();
});
