import { postgresFailure } from '@pertexo/database/primitives';
import { IdempotencyRequestConflictError } from '../runs/commands/acceptance/errors.js';
import {
  IdentityConflictError,
  WorkspaceLifecycleConflictError,
  type IdentityConflictReason,
} from './errors.js';

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

export function throwWorkspaceLifecycleError(error: unknown): never {
  const { code } = postgresFailure(error);
  if (code === '23505') throw new IdempotencyRequestConflictError();
  if (code === '42501')
    throw new WorkspaceLifecycleConflictError(
      'actor_inactive',
      'Workspace lifecycle actor is not authorized',
      { cause: error },
    );
  if (code === '55000' || code === '23503')
    throw new WorkspaceLifecycleConflictError(
      'invalid_state',
      'Workspace lifecycle transition is not valid',
      { cause: error },
    );
  throw error;
}
