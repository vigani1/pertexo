import type { Pool, PoolClient } from 'pg';

export function assertCoordinatorNotAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new DOMException('The operation was aborted', 'AbortError');
}

async function acquirePoolClient(
  pool: Pool,
  signal: AbortSignal,
  abortFailure: Error,
): Promise<PoolClient> {
  const connection = pool.connect();
  let rejectAbort: ((reason: Error) => void) | undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => {
    rejectAbort?.(abortFailure);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal.aborted) throw abortFailure;
    return await Promise.race([connection, abort]);
  } catch (error: unknown) {
    if (signal.aborted)
      void connection.then(
        (client) => {
          client.release(abortFailure);
        },
        () => undefined,
      );
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function withCoordinatorClient<T>(
  pool: Pool,
  workspaceId: string,
  signal: AbortSignal,
  beginStatement: 'begin' | 'begin isolation level repeatable read read only',
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  assertCoordinatorNotAborted(signal);
  const abortFailure = new Error('Coordinator transaction aborted');
  abortFailure.name = 'AbortError';
  const client = await acquirePoolClient(pool, signal, abortFailure);
  const connectionState = { released: false };
  const releaseForAbort = (): void => {
    if (connectionState.released) return;
    connectionState.released = true;
    client.release(abortFailure);
  };
  signal.addEventListener('abort', releaseForAbort, { once: true });
  try {
    assertCoordinatorNotAborted(signal);
    await client.query(beginStatement);
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
    const result = await operation(client);
    assertCoordinatorNotAborted(signal);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    if (signal.aborted) throw abortFailure;
    if (!connectionState.released)
      await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', releaseForAbort);
    if (!connectionState.released) {
      connectionState.released = true;
      client.release();
    }
  }
}

export function withCoordinatorReadClient<T>(
  pool: Pool,
  workspaceId: string,
  signal: AbortSignal,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withCoordinatorClient(
    pool,
    workspaceId,
    signal,
    'begin isolation level repeatable read read only',
    operation,
  );
}

export function withCoordinatorWriteClient<T>(
  pool: Pool,
  workspaceId: string,
  signal: AbortSignal,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withCoordinatorClient(pool, workspaceId, signal, 'begin', operation);
}
