import { Client, type PoolClient } from 'pg';

interface PoolClientWithStream {
  readonly host?: string;
  readonly port?: number;
  readonly processID?: number;
  readonly secretKey?: number;
  readonly ssl?: boolean | object;
  _getActiveQuery?(): unknown;
  readonly connection?: {
    readonly stream?: {
      destroy(): void;
    };
  };
}

function requestWireCancellation(
  client: PoolClientWithStream,
  join = false,
): void | Promise<void> {
  const activeQuery = client._getActiveQuery?.();
  if (
    activeQuery === undefined ||
    activeQuery === null ||
    client.processID === undefined ||
    client.secretKey === undefined
  )
    return;
  const processId = client.processID;
  const secretKey = client.secretKey;
  const canceler = new Client({
    ...(client.host === undefined ? {} : { host: client.host }),
    ...(client.port === undefined ? {} : { port: client.port }),
    ...(client.ssl === undefined ? {} : { ssl: client.ssl }),
  });
  // CancelRequest is a separate unauthenticated PostgreSQL protocol message.
  // The server closes this short-lived socket after consuming it.
  const connection = canceler.connection as unknown as {
    cancel(processId: number, secretKey: number): void;
    connect(portOrPath: number | string, host?: string): void;
    once(event: 'connect', listener: () => void): void;
    readonly stream: {
      destroy(): void;
      once?(event: 'close', listener: () => void): void;
      removeListener?(event: 'close', listener: () => void): void;
    };
    on(event: 'error', listener: () => void): void;
    removeListener(event: string, listener: (...args: never[]) => void): void;
  };
  if (join)
    return new Promise<void>((resolve, reject) => {
      let failure: Readonly<{ error: unknown }> | undefined;
      const originalStream = connection.stream;
      const finish = (): void => {
        clearTimeout(cleanup);
        connection.removeListener('error', onError);
        connection.removeListener('connect', onConnect);
        connection.removeListener('end', finish);
        originalStream.removeListener?.('close', finish);
        if (failure === undefined) resolve();
        else
          reject(
            failure.error instanceof Error
              ? failure.error
              : new Error('CancelRequest transport failed', {
                  cause: failure.error,
                }),
          );
      };
      const onError = (error?: unknown): void => {
        failure ??= { error };
        connection.stream.destroy();
      };
      const onConnect = (): void => {
        try {
          connection.cancel(processId, secretKey);
        } catch (error: unknown) {
          onError(error);
        }
      };
      // Timeout initiates teardown; only a terminal event completes ownership.
      const cleanup = setTimeout(() => {
        connection.stream.destroy();
      }, 1_000);
      connection.on('error', onError);
      connection.once('connect', onConnect);
      // Pinned connection emits end on socket close. Observing the original
      // socket as well handles synchronous connect setup failure before that
      // driver's own close listener has been attached.
      const terminalConnection = connection as unknown as {
        once(event: 'end', listener: () => void): void;
      };
      terminalConnection.once('end', finish);
      originalStream.once?.('close', finish);
      try {
        if (client.host?.startsWith('/'))
          connection.connect(`${client.host}/.s.PGSQL.${String(client.port)}`);
        else connection.connect(client.port ?? 5_432, client.host);
      } catch (error: unknown) {
        onError(error);
      }
    });
  connection.on('error', () => undefined);
  try {
    connection.once('connect', () => {
      connection.cancel(processId, secretKey);
    });
    if (client.host?.startsWith('/'))
      connection.connect(`${client.host}/.s.PGSQL.${String(client.port)}`);
    else connection.connect(client.port ?? 5_432, client.host);
  } catch {
    void canceler.end().catch(() => undefined);
    return;
  }
  const cleanup = setTimeout(() => {
    connection.stream.destroy();
  }, 1_000);
  cleanup.unref();
}

/**
 * Removes a canceled checked-out client and terminates its PostgreSQL socket.
 *
 * pg-pool's error release calls Client.end(). In pipeline mode Client.end()
 * waits for the active query to drain, so release(error) alone does not own
 * wire cancellation. The pinned driver exposes the connection stream on the
 * checked-out client; destroying it makes backend termination authoritative.
 */
export function destroyCanceledPoolClient(
  client: PoolClient,
  error: Error,
  options: Readonly<{ join: true; termination?: Promise<void> }>,
): Promise<void>;
export function destroyCanceledPoolClient(
  client: PoolClient,
  error: Error,
): void;
export function destroyCanceledPoolClient(
  client: PoolClient,
  error: Error,
  options?: Readonly<{ join: true; termination?: Promise<void> }>,
): void | Promise<void> {
  const cancellable = client as PoolClientWithStream;
  const stream = cancellable.connection?.stream;
  if (options === undefined) {
    void requestWireCancellation(cancellable);
    try {
      client.release(error);
    } finally {
      stream?.destroy();
    }
    return;
  }
  const terminated =
    options.termination ??
    new Promise<void>((resolve) => {
      client.once('end', resolve);
    });
  const disposalErrors: unknown[] = [];
  let cancellation: void | Promise<void> = undefined;
  try {
    cancellation = requestWireCancellation(cancellable, options.join);
  } catch (failure: unknown) {
    disposalErrors.push(failure);
  }
  try {
    client.release(error);
  } catch (failure: unknown) {
    disposalErrors.push(failure);
  } finally {
    try {
      stream?.destroy();
    } catch (failure: unknown) {
      disposalErrors.push(failure);
    }
  }
  return Promise.allSettled([terminated, Promise.resolve(cancellation)]).then(
    (results) => {
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason as unknown] : [],
      );
      failures.push(...disposalErrors);
      // Re-throwing the exact cancellation object adds no independent failure.
      // A different AbortError or transport/bookkeeping error remains diagnostic.
      const independentFailures = [
        ...new Set(failures.filter((failure) => failure !== error)),
      ];
      if (independentFailures.length > 0)
        throw new AggregateError(
          independentFailures,
          'Canceled client disposal failed',
        );
    },
  );
}
