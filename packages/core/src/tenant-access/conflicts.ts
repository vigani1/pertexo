import { postgresFailure } from '@pertexo/database/primitives';
import {
  IdentityConflictError,
  type IdentityConflictReason,
} from './tenant-access.errors.js';

export function throwIdentityDatabaseConflict(
  error: unknown,
  message: string,
  reason: IdentityConflictReason = 'identity',
): never {
  const { code } = postgresFailure(error);
  const constraintFailure =
    code === '23505' || code === '23503' || code === '23514';
  if (constraintFailure)
    throw new IdentityConflictError(message, { cause: error, reason });
  throw error;
}
