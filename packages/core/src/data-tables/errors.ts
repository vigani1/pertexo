import { postgresFailure, queryFailure } from '@pertexo/database/primitives';
import { DataTableError } from '@pertexo/node-sdk';

import { ExecutionCapabilityExpiredError } from '../attempts/errors.js';

const TRANSIENT_STORAGE_CODES = [
  '53300',
  '57P01',
  '57P02',
  '57P03',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
];

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
  const { code } = postgresFailure(caught);
  if (
    code !== undefined &&
    (/^(?:08|40)/u.test(code) || TRANSIENT_STORAGE_CODES.includes(code))
  )
    throw new DataTableError(
      'unavailable',
      'Data table storage is temporarily unavailable. The same write can be retried safely.',
    );
  return translateTableConstraint(caught);
}
