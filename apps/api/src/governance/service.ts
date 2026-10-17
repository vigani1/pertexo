import {
  GovernanceError,
  type GovernanceStore,
} from '@pertexo/database/governance';
import { WorkspaceAccessDeniedError } from '@pertexo/database/tenant-access';
import { IdempotencyConflictError } from '@pertexo/database/platform';
import {
  applicationError,
  throwApplicationError,
} from '../platform/http/index.js';
export class GovernanceService {
  constructor(readonly store: GovernanceStore) {}
  async perform<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof GovernanceError)
        throwApplicationError(
          applicationError(
            error.reason === 'conflict'
              ? 'workspace.conflict'
              : 'request.invalid',
            { safeDetail: error.message },
          ),
        );
      if (error instanceof WorkspaceAccessDeniedError)
        throwApplicationError(applicationError('resource.not_found'));
      if (error instanceof IdempotencyConflictError)
        throwApplicationError(applicationError('request.idempotency_conflict'));
      throw error;
    }
  }
}
