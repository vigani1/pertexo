import { DataTableError } from '@pertexo/node-sdk';
import { WorkspaceAccessDeniedError } from '@pertexo/database/tenant-access';
import { IdempotencyConflictError } from '@pertexo/database/platform';
import { z } from 'zod';
import {
  applicationError,
  isApplicationError,
  type ApplicationError,
} from '../platform/http/index.js';
export function mapDataTableError(error: unknown): ApplicationError {
  if (isApplicationError(error)) return error;
  if (error instanceof WorkspaceAccessDeniedError)
    return applicationError('resource.not_found');
  if (error instanceof IdempotencyConflictError)
    return applicationError('request.idempotency_conflict');
  if (error instanceof DataTableError)
    return applicationError(
      error.code === 'not_found'
        ? 'resource.not_found'
        : ['conflict', 'key_conflict', 'quota_exceeded'].includes(error.code)
          ? 'workspace.conflict'
          : 'request.invalid',
      { safeDetail: error.message },
    );
  if (error instanceof z.ZodError)
    return applicationError('request.invalid', {
      safeDetail:
        error.issues[0]?.message ?? 'The data table request is invalid.',
    });
  return applicationError('internal.unexpected', { cause: error });
}
