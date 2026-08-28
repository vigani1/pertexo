import type { Pool, PoolClient } from 'pg';

export function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new DOMException('The operation was aborted', 'AbortError');
}

export function scopedInvocationKey(
  input: Readonly<{
    workflowVersionId: string;
    nodeId: string;
    branchPath?: readonly Readonly<{ nodeId: string; outputPort: string }>[];
    iterationPath?: readonly Readonly<{
      loopNodeId: string;
      ordinal: number;
    }>[];
  }>,
): string {
  const branches = (input.branchPath ?? [])
    .map(({ nodeId, outputPort }) => `${nodeId}:${outputPort}`)
    .join('/');
  const iterations = (input.iterationPath ?? [])
    .map(({ loopNodeId, ordinal }) => `${loopNodeId}:${String(ordinal)}`)
    .join('/');
  return `${encodeURIComponent(input.workflowVersionId)}|${encodeURIComponent(input.nodeId)}|b:${encodeURIComponent(branches)}|i:${encodeURIComponent(iterations)}`;
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
  const onAbort = (): void => rejectAbort?.(abortFailure);
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

export async function withWorkspaceWriteClient<T>(
  pool: Pool,
  workspaceId: string,
  signal: AbortSignal,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  assertNotAborted(signal);
  const abortFailure = new Error('Node attempt transaction aborted');
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
    assertNotAborted(signal);
    await client.query('begin');
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
    const result = await operation(client);
    assertNotAborted(signal);
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

export async function withWorkspaceReadClient<T>(
  pool: Pool,
  workspaceId: string,
  signal: AbortSignal,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  assertNotAborted(signal);
  const abortFailure = new Error('Node attempt read aborted');
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
    assertNotAborted(signal);
    await client.query('begin isolation level repeatable read read only');
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
    const result = await operation(client);
    assertNotAborted(signal);
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
