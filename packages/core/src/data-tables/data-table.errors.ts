import { isTransientDatabaseFailure } from '@pertexo/database/platform';
import { postgresFailure, queryFailure } from '@pertexo/database/primitives';
import { DataTableError } from '@pertexo/node-sdk';

import { ExecutionCapabilityExpiredError } from '../attempts/node-attempt.errors.js';

export function translateTableConstraint(caught: unknown): never {
  const { code, constraint } = postgresFailure(caught);
  if (code === '23505')
    throw new DataTableError(
      'key_conflict',
      constraint === 'workspace_data_tables_name'
        ? 'A table with this name already exists. Choose another name.'
        : 'Another row already uses this unique key.',
    );
  throw queryFailure(caught);
}

/** A workflow's step can retry safely, so it needs to know when that's the answer. */
export function translateWorkerFailure(caught: unknown): never {
  if (caught instanceof ExecutionCapabilityExpiredError)
    throw new DataTableError('attempt_expired', caught.message);
  if (isTransientDatabaseFailure(caught))
    throw new DataTableError(
      'unavailable',
      'Data table storage is temporarily unavailable. The same write can be retried safely.',
    );
  return translateTableConstraint(caught);
}

export class StoredTableDefinitionError extends Error {
  public constructor(options: ErrorOptions) {
    super('Stored table definition is invalid', options);
    this.name = 'StoredTableDefinitionError';
  }
}
