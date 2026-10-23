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
