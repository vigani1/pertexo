import { errorRegistration } from '../../platform/http/problems/registry.js';
import { ApiTokenPolicyError } from '@pertexo/core/tenant-access';
import { applicationError } from '../../platform/http/index.js';

export const tokensProblems = [
  errorRegistration(ApiTokenPolicyError, (error) => {
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
  }),
];
