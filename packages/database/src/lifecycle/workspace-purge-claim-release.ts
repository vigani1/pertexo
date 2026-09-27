import type { QueryResult } from 'pg';

type PurgePlatformQuery = <Row extends Record<string, unknown>>(
  text: string,
  values: readonly unknown[],
  signal?: AbortSignal,
) => Promise<QueryResult<Row>>;

function isClaimRace(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '55P03'
  );
}

function isLegalHold(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string' &&
    error.message.includes('active workspace legal hold')
  );
}

function isFenceChanged(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes('control fence changed') ||
      error.message.includes('projection fence changed'))
  );
}

export function isRecoverablePurgeClaimError(error: unknown): boolean {
  return isClaimRace(error) || isFenceChanged(error);
}

export function isRecoverablePurgeCompletionError(error: unknown): boolean {
  return isLegalHold(error) || isRecoverablePurgeClaimError(error);
}

async function releaseClaimAfterFailure(
  query: PurgePlatformQuery,
  statement: string,
  values: readonly unknown[],
  originalError: unknown,
  failureMessage: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const released = await query<{ changed: boolean }>(
      statement,
      values,
      signal,
    );
    return released.rows[0]?.changed === true;
  } catch (releaseError: unknown) {
    throw new AggregateError([originalError, releaseError], failureMessage);
  }
}

export function releasePurgeCompletionClaimAfterFailure(
  query: PurgePlatformQuery,
  jobId: string,
  leaseToken: string,
  leaseFence: number,
  originalError: unknown,
  signal?: AbortSignal,
): Promise<boolean> {
  return releaseClaimAfterFailure(
    query,
    'select app.release_workspace_purge_completion($1,$2,$3) changed',
    [jobId, leaseToken, leaseFence],
    originalError,
    'Workspace purge completion and claim release both failed',
    signal,
  );
}

export function releasePurgeJobClaimAfterFailure(
  query: PurgePlatformQuery,
  jobId: string,
  leaseToken: string,
  leaseFence: number,
  originalError: unknown,
  signal?: AbortSignal,
): Promise<boolean> {
  return releaseClaimAfterFailure(
    query,
    'select app.release_workspace_purge_job($1,$2,$3) changed',
    [jobId, leaseToken, leaseFence],
    originalError,
    'Workspace purge operation and claim release both failed',
    signal,
  );
}
