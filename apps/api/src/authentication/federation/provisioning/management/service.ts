import {
  DirectoryError,
  WorkspaceAccessDeniedError,
  type DirectoryStore,
} from '@pertexo/database/tenant-access';
import { IdempotencyConflictError } from '@pertexo/database/platform';
import {
  applicationError,
  throwApplicationError,
} from '../../../../platform/http/index.js';

export class DirectoryManagementService {
  constructor(readonly store: DirectoryStore) {}
  async perform<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error: unknown) {
      if (error instanceof WorkspaceAccessDeniedError)
        throwApplicationError(applicationError('resource.not_found'));
      if (error instanceof IdempotencyConflictError)
        throwApplicationError(applicationError('request.idempotency_conflict'));
      if (error instanceof DirectoryError) {
        if (error.reason === 'not_found')
          throwApplicationError(applicationError('resource.not_found'));
        if (error.reason === 'stale')
          throwApplicationError(
            applicationError('workspace.conflict', {
              safeDetail:
                'Directory settings or membership changed. Reload before saving.',
            }),
          );
        if (error.reason === 'owner_protected')
          throwApplicationError(
            applicationError('auth.forbidden', {
              safeDetail:
                'Keep the recovery owner outside directory management.',
            }),
          );
        if (error.reason === 'forbidden' || error.reason === 'unauthorized')
          throwApplicationError(
            applicationError('auth.forbidden', {
              safeDetail:
                'Only the current control workspace owner can manage this directory. A linked workspace owner may unlink their own workspace.',
            }),
          );
        throwApplicationError(
          applicationError('request.invalid', {
            safeDetail:
              error.reason === 'limit'
                ? 'The directory limit has been reached. Revoke an unused credential or reduce the directory size.'
                : 'Check the directory, group, workspace and membership values. Only active verified people can be adopted.',
          }),
        );
      }
      throw error;
    }
  }
}
