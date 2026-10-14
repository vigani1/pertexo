import { ApiTokenPolicyError } from '@pertexo/database/tenant-access';
import {
  applicationError,
  type ApplicationError,
} from '../platform/http/index.js';
import { mapIdentityWorkspaceError } from '../workspaces/errors.js';

export function mapApiTokenError(error: unknown): ApplicationError {
  if (!(error instanceof ApiTokenPolicyError))
    return mapIdentityWorkspaceError(error);
  if (error.reason === 'not_found')
    return applicationError('resource.not_found');
  if (error.reason === 'token_limit')
    return applicationError('api_token.limit', {
      safeDetail:
        'Revoke an active token before creating another. A member can have ten active tokens in this workspace.',
    });
  return applicationError('auth.forbidden', {
    safeDetail:
      'The token operation exceeds your current workspace permissions.',
  });
}
