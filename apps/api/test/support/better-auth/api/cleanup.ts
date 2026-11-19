import {
  describeCleanupFailure,
  FixtureCleanupError,
  formatCleanupFailure,
  type FixtureCleanupFailure,
} from '../../../browser/harness/resource-owner.js';
import type { DatabaseCleanupFailure } from './contract.js';

export function databaseCleanupFailure(error: unknown): DatabaseCleanupFailure {
  const message: unknown =
    error instanceof Error
      ? Object.getOwnPropertyDescriptor(error, 'message')?.value
      : undefined;
  if (typeof message === 'string') {
    const stage =
      /^Disposable database (connection_probe|poll_wait|drop) (?:query exceeded [1-9][0-9]{0,8}ms|deadline expired before dispatch)$/u.exec(
        message,
      )?.[1];
    if (stage === 'connection_probe')
      return 'database_connection_probe_deadline';
    if (stage === 'poll_wait') return 'database_poll_wait_deadline';
    if (stage === 'drop') return 'database_drop_deadline';
  }
  if (
    typeof message === 'string' &&
    /^Disposable database query exceeded [1-9][0-9]{0,8}ms$/u.test(message)
  )
    return 'database_query_deadline';
  return message === 'Query read timeout'
    ? 'database_query_read_timeout'
    : 'database_cleanup_failure';
}

export const DISPOSABLE_DATABASE = 'disposable database';

/**
 * The safe labels the fixture reports: the disposable database's own label,
 * then each other failed resource by name, error class and known code.
 * Vitest serializes nested errors with their causes and properties, so no
 * original error crosses this boundary.
 */
export function cleanupFailureReport(
  input: Readonly<{
    databaseCleanup: DatabaseCleanupFailure | undefined;
    beforeClose: { error: unknown } | undefined;
    owner: { error: unknown } | undefined;
  }>,
): string[] {
  const others = [
    ...(input.beforeClose === undefined
      ? []
      : [describeCleanupFailure('before close', input.beforeClose.error)]),
    ...(input.owner === undefined ? [] : ownerFailures(input.owner.error)),
  ];
  return [
    ...(input.databaseCleanup === undefined ? [] : [input.databaseCleanup]),
    ...others.map(formatCleanupFailure),
  ];
}

function ownerFailures(error: unknown): FixtureCleanupFailure[] {
  if (!(error instanceof FixtureCleanupError))
    return [describeCleanupFailure('resource owner', error)];
  // The database's failure is already reported by its specific label.
  return error.failures.filter(
    (failure) => failure.resource !== DISPOSABLE_DATABASE,
  );
}
