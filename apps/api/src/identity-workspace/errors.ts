import {
  IdentityConflictError,
  IdempotencyRequestConflictError,
  WorkspaceAccessDeniedError,
  WorkspaceLifecycleConflictError,
  WorkspaceMemberRoleCommandConflictError,
  WorkspaceMemberRemovalCommandConflictError,
  WorkspaceRenameCommandConflictError,
  WorkspaceInvitationCommandConflictError,
  InvitationAcceptanceConflictError,
  UserProfileCommandConflictError,
  type WorkspaceMemberRoleCommandConflictReason,
  type WorkspaceMemberRemovalCommandConflictReason,
} from '@pertexo/database/api';
import {
  applicationError,
  type ApplicationError,
} from '../platform/http/index.js';
import { z } from 'zod';
import {
  AuthorizationError,
  type AuthorizationErrorCode,
} from '../workspaces/index.js';
import { isIdentityError, type IdentityError } from '../identity/index.js';
import { InvalidAuthenticatedWorkspaceContextError } from './authenticated-command-context-error.js';

function workspaceApplicationError(
  code: AuthorizationErrorCode,
  safeDetail?: string,
): ApplicationError {
  return applicationError(code, safeDetail === undefined ? {} : { safeDetail });
}

export function mapIdentityWorkspaceError(error: unknown): ApplicationError {
  if (error instanceof InvalidAuthenticatedWorkspaceContextError)
    return applicationError('request.invalid', { safeDetail: error.message });
  if (error instanceof z.ZodError) {
    return applicationError('request.invalid', {
      safeDetail: 'The request is invalid.',
    });
  }
  if (error instanceof AuthorizationError) {
    return workspaceApplicationError(error.code, error.message);
  }
  if (isIdentityError(error)) {
    return mapIdentityError(error);
  }
  if (error instanceof WorkspaceLifecycleConflictError) {
    if (error.reason === 'invalid_state') {
      return applicationError('workspace.conflict', {
        safeDetail: 'The workspace is not in a valid state for this operation.',
      });
    }
    return applicationError('auth.forbidden', {
      safeDetail: 'The workspace cannot perform this lifecycle operation.',
    });
  }
  if (error instanceof WorkspaceMemberRoleCommandConflictError)
    return mapMemberCommandConflict(error.reason, {
      revision: 'The member role changed since it was loaded.',
      inactive: applicationError('workspace.member_role_transition_conflict', {
        safeDetail: 'Only an active member role can be changed.',
      }),
      forbidden: 'This member role transition is not allowed.',
    });
  if (error instanceof WorkspaceMemberRemovalCommandConflictError)
    return mapMemberCommandConflict(error.reason, {
      revision: 'The member changed since it was loaded.',
      inactive: applicationError('workspace.member_removal_conflict', {
        safeDetail: 'The member is no longer in this workspace.',
      }),
      forbidden: 'This member cannot be removed by you.',
    });
  if (error instanceof UserProfileCommandConflictError)
    return mapProfileConflict(error);
  if (error instanceof WorkspaceRenameCommandConflictError) {
    if (error.reason === 'revision_conflict')
      return applicationError('workspace.revision_conflict', {
        safeDetail: 'The workspace changed since it was loaded.',
      });
    if (error.reason === 'idempotency_conflict')
      return applicationError('request.idempotency_conflict', {
        safeDetail: 'The idempotency key was already used for another request.',
      });
    if (error.reason === 'workspace_inactive')
      return applicationError('workspace.conflict', {
        safeDetail: 'Only an active workspace can be renamed.',
      });
    return applicationError('auth.forbidden', {
      safeDetail: 'The workspace cannot be renamed by this actor.',
    });
  }
  if (error instanceof WorkspaceInvitationCommandConflictError) {
    if (error.reason === 'invitation_missing')
      return applicationError('workspace.invitation_unavailable');
    if (error.reason === 'revision_conflict')
      return applicationError('workspace.invitation_revision_conflict', {
        safeDetail: 'The invitation changed since it was loaded.',
      });
    if (error.reason === 'idempotency_conflict')
      return applicationError('request.idempotency_conflict', {
        safeDetail: 'The idempotency key was already used for another request.',
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
  }
  if (error instanceof InvitationAcceptanceConflictError) {
    if (error.reason === 'unavailable')
      return applicationError('workspace.invitation_unavailable');
    if (error.reason === 'recipient_mismatch')
      return applicationError('workspace.invitation_recipient_mismatch', {
        safeDetail: 'Sign in with the address that received the invitation.',
      });
    if (error.reason === 'idempotency_conflict')
      return applicationError('request.idempotency_conflict', {
        safeDetail: 'The idempotency key was already used for another request.',
      });
    if (error.reason === 'proof_expired')
      return applicationError('workspace.invitation_proof_expired', {
        safeDetail: 'Verify the invited account again before accepting.',
      });
    return applicationError('workspace.invitation_conflict', {
      safeDetail: error.message,
    });
  }
  if (error instanceof IdentityConflictError) {
    if (error.reason === 'workspace_slug') {
      return applicationError('workspace.conflict', {
        safeDetail: 'The workspace slug is already in use.',
      });
    }
    return applicationError('request.invalid', {
      safeDetail: 'The request conflicts with existing identity data.',
    });
  }
  if (error instanceof IdempotencyRequestConflictError) {
    return applicationError('request.idempotency_conflict', {
      safeDetail: 'The idempotency key was already used for another request.',
    });
  }
  if (error instanceof WorkspaceAccessDeniedError) {
    return applicationError('auth.forbidden', {
      safeDetail: 'The actor is no longer authorized for this workspace.',
    });
  }
  return applicationError('internal.unexpected', { cause: error });
}

const IDEMPOTENCY_CONFLICT_DETAIL =
  'The idempotency key was already used for another request.';

/** ADR 037 and ADR 042 member commands share one conflict vocabulary. */
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
  if (reason === 'idempotency_conflict')
    return applicationError('request.idempotency_conflict', {
      safeDetail: IDEMPOTENCY_CONFLICT_DETAIL,
    });
  if (reason === 'target_inactive') return copy.inactive;
  return applicationError('auth.forbidden', { safeDetail: copy.forbidden });
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

function mapIdentityError(error: IdentityError): ApplicationError {
  if (
    error.code === 'identity.session_invalid' ||
    error.code === 'identity.session_expired' ||
    error.code === 'identity.session_revoked'
  ) {
    return applicationError('auth.unauthenticated');
  }
  if (error.code === 'identity.csrf_failed') {
    return applicationError('auth.forbidden', {
      safeDetail: 'The request could not be verified.',
    });
  }
  if (error.code === 'identity.provider_unavailable') {
    return applicationError('provider.unavailable', {
      safeDetail: 'The identity provider is temporarily unavailable.',
      cause: error,
    });
  }
  return applicationError('request.invalid', { safeDetail: error.message });
}
