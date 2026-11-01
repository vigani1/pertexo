import { InvalidWorkspaceMemberCursorError } from '../../workspaces/cursor.js';
import { AuthorizationError } from '../../authorization/index.js';
import { IdempotencyConflictError } from '@pertexo/database/platform';
import { errorRegistration } from '../../platform/http/problems/registry.js';
import {
  DirectoryManagedMembershipError,
  IdentityConflictError,
  WorkspaceAccessDeniedError,
  WorkspaceLifecycleConflictError,
  WorkspaceMemberRoleCommandConflictError,
  WorkspaceMemberRemovalCommandConflictError,
  WorkspaceMembershipCommandConflictError,
  WorkspaceRenameCommandConflictError,
  WorkspaceInvitationCommandConflictError,
  InvitationAcceptanceConflictError,
  UserProfileCommandConflictError,
  type WorkspaceMemberRoleCommandConflictReason,
  type WorkspaceMemberRemovalCommandConflictReason,
} from '@pertexo/core/tenant-access';
import { IdempotencyRequestConflictError } from '@pertexo/core/runs';
import {
  applicationError,
  type ApplicationError,
} from '../../platform/http/index.js';
import { InvalidAuthenticatedWorkspaceContextError } from '../../workspaces/request/authenticated-context-error.js';
import { IdentityError } from '../../identity/errors.js';

export const identityProblems = [
  errorRegistration(InvalidWorkspaceMemberCursorError, () =>
    applicationError('request.invalid', {
      safeDetail: 'workspace member cursor is invalid',
    }),
  ),
  errorRegistration(AuthorizationError, (error) => {
    return applicationError(error.code, {
      safeDetail: error.message,
    });
  }),
  errorRegistration(IdempotencyConflictError, () => {
    return applicationError('request.idempotency_conflict');
  }),
  errorRegistration(DirectoryManagedMembershipError, (error) => {
    return applicationError('workspace.member_directory_managed', {
      safeDetail: error.message,
    });
  }),
  errorRegistration(InvalidAuthenticatedWorkspaceContextError, (error) => {
    return applicationError('request.invalid', { safeDetail: error.message });
  }),
  errorRegistration(WorkspaceLifecycleConflictError, (error) => {
    if (error.reason === 'invalid_state') {
      return applicationError('workspace.conflict', {
        safeDetail: 'The workspace is not in a valid state for this operation.',
      });
    }
    return applicationError('auth.forbidden', {
      safeDetail: 'The workspace cannot perform this lifecycle operation.',
    });
  }),
  errorRegistration(WorkspaceMemberRoleCommandConflictError, (error) => {
    return mapMemberCommandConflict(error.reason, {
      revision: 'The member role changed since it was loaded.',
      inactive: applicationError('workspace.member_role_transition_conflict', {
        safeDetail: 'Only an active member role can be changed.',
      }),
      forbidden: 'This member role transition is not allowed.',
    });
  }),
  errorRegistration(WorkspaceMemberRemovalCommandConflictError, (error) => {
    return mapMemberCommandConflict(error.reason, {
      revision: 'The member changed since it was loaded.',
      inactive: applicationError('workspace.member_removal_conflict', {
        safeDetail: 'The member is no longer in this workspace.',
      }),
      forbidden: 'This member cannot be removed by you.',
    });
  }),
  errorRegistration(WorkspaceMembershipCommandConflictError, (error) => {
    return mapMembershipConflict(error);
  }),
  errorRegistration(UserProfileCommandConflictError, (error) => {
    return mapProfileConflict(error);
  }),
  errorRegistration(WorkspaceRenameCommandConflictError, (error) => {
    if (error.reason === 'revision_conflict')
      return applicationError('workspace.revision_conflict', {
        safeDetail: 'The workspace changed since it was loaded.',
      });
    if (error.reason === 'workspace_inactive')
      return applicationError('workspace.conflict', {
        safeDetail: 'Only an active workspace can be renamed.',
      });
    return applicationError('auth.forbidden', {
      safeDetail: 'The workspace cannot be renamed by this actor.',
    });
  }),
  errorRegistration(WorkspaceInvitationCommandConflictError, (error) => {
    if (error.reason === 'invitation_missing')
      return applicationError('workspace.invitation_unavailable');
    if (error.reason === 'revision_conflict')
      return applicationError('workspace.invitation_revision_conflict', {
        safeDetail: 'The invitation changed since it was loaded.',
      });
    if (error.reason === 'delivery_unresolved')
      return applicationError('workspace.invitation_delivery_unavailable', {
        safeDetail:
          'The prior delivery outcome must be reconciled before resending.',
      });
    if (
      error.reason === 'duplicate_pending' ||
      error.reason === 'invitation_inactive'
    )
      return applicationError('workspace.invitation_conflict', {
        safeDetail: error.message,
      });
    return applicationError('auth.forbidden', {
      safeDetail: 'This invitation command is not allowed.',
    });
  }),
  errorRegistration(InvitationAcceptanceConflictError, (error) => {
    if (error.reason === 'unavailable')
      return applicationError('workspace.invitation_unavailable');
    if (error.reason === 'recipient_mismatch')
      return applicationError('workspace.invitation_recipient_mismatch', {
        safeDetail: 'Sign in with the address that received the invitation.',
      });
    if (error.reason === 'proof_expired')
      return applicationError('workspace.invitation_proof_expired', {
        safeDetail: 'Verify the invited account again before accepting.',
      });
    return applicationError('workspace.invitation_conflict', {
      safeDetail: error.message,
    });
  }),
  errorRegistration(IdentityConflictError, (error) => {
    if (error.reason === 'workspace_slug') {
      return applicationError('workspace.conflict', {
        safeDetail: 'The workspace slug is already in use.',
      });
    }
    return applicationError('request.invalid', {
      safeDetail: 'The request conflicts with existing identity data.',
    });
  }),
  errorRegistration(IdempotencyRequestConflictError, () => {
    return applicationError('request.idempotency_conflict', {
      safeDetail: 'The idempotency key was already used for another request.',
    });
  }),
  errorRegistration(WorkspaceAccessDeniedError, () => {
    return applicationError('auth.forbidden', {
      safeDetail: 'The actor is no longer authorized for this workspace.',
    });
  }),
  errorRegistration(IdentityError, identityProblem),
];

function mapMemberCommandConflict(
  reason:
    | WorkspaceMemberRoleCommandConflictReason
    | WorkspaceMemberRemovalCommandConflictReason,
  copy: Readonly<{
    revision: string;
    inactive: ApplicationError;
    forbidden: string;
  }>,
): ApplicationError {
  if (reason === 'target_missing')
    return applicationError('resource.not_found');
  if (reason === 'revision_conflict')
    return applicationError('workspace.member_role_revision_conflict', {
      safeDetail: copy.revision,
    });
  if (reason === 'target_inactive') return copy.inactive;
  return applicationError('auth.forbidden', { safeDetail: copy.forbidden });
}
function mapMembershipConflict(
  error: WorkspaceMembershipCommandConflictError,
): ApplicationError {
  switch (error.reason) {
    case 'target_missing':
      return applicationError('resource.not_found');
    case 'revision_conflict':
      return applicationError('workspace.member_role_revision_conflict', {
        safeDetail: 'A membership changed since it was loaded.',
      });
    case 'target_removed':
      return applicationError('workspace.member_removal_conflict', {
        safeDetail: 'The member is no longer in this workspace.',
      });
    case 'target_inactive':
      return applicationError('workspace.member_status_conflict', {
        safeDetail: 'The member is not in a state that allows this.',
      });
    case 'owner_departure':
      return applicationError('auth.forbidden', {
        safeDetail: 'The owner must transfer ownership before leaving.',
      });
    case 'actor_inactive':
    case 'command_forbidden':
    case 'owner_target':
    case 'self_command':
    default:
      return applicationError('auth.forbidden', {
        safeDetail: 'This membership change is not allowed.',
      });
  }
}
function mapProfileConflict(
  error: UserProfileCommandConflictError,
): ApplicationError {
  if (error.reason === 'revision_conflict')
    return applicationError('user.profile_revision_conflict', {
      safeDetail: 'Your profile changed since it was loaded.',
    });
  if (error.reason === 'idempotency_conflict')
    return applicationError('request.idempotency_conflict', {
      safeDetail: IDEMPOTENCY_CONFLICT_DETAIL,
    });
  return applicationError('auth.unauthenticated');
}
function identityProblem(error: IdentityError): ApplicationError {
  if (error.code === 'identity.session_invalid')
    return applicationError('auth.unauthenticated');
  if (error.code === 'identity.session_not_fresh')
    return applicationError('auth.session_not_fresh', {
      safeDetail: 'Sign in again, then retry within five minutes.',
    });
  if (error.code === 'identity.csrf_failed') {
    return applicationError('auth.forbidden', {
      safeDetail: 'The request could not be verified.',
    });
  }
  return applicationError('request.invalid', { safeDetail: error.message });
}
const IDEMPOTENCY_CONFLICT_DETAIL =
  'The idempotency key was already used for another request.';
