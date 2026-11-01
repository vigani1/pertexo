import { errorRegistration } from '../../platform/http/problems/registry.js';
import { DirectoryError } from '@pertexo/core/identity';
import { applicationError } from '../../platform/http/index.js';

export const directoryProblems = [
  errorRegistration(DirectoryError, (error) => {
    if (error.reason === 'not_found')
      return applicationError('resource.not_found');
    if (error.reason === 'stale')
      return applicationError('workspace.conflict', {
        safeDetail:
          'Directory settings or membership changed. Reload before saving.',
      });
    if (error.reason === 'owner_protected')
      return applicationError('auth.forbidden', {
        safeDetail: 'Keep the recovery owner outside directory management.',
      });
    if (error.reason === 'forbidden' || error.reason === 'unauthorized')
      return applicationError('auth.forbidden', {
        safeDetail:
          'Only the current control workspace owner can manage this directory. A linked workspace owner may unlink their own workspace.',
      });
    return applicationError('request.invalid', {
      safeDetail:
        error.reason === 'limit'
          ? 'The directory limit has been reached. Revoke an unused credential or reduce the directory size.'
          : 'Check the directory, group, workspace and membership values. Only active verified people can be adopted.',
    });
  }),
];
