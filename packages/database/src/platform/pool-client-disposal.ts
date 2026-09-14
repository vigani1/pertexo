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

function requestWireCancellation(client: PoolClientWithStream): void {
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
    readonly stream: { destroy(): void };
    on(event: 'error', listener: () => void): void;
  };
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
): void {
  const cancellable = client as PoolClientWithStream;
  const stream = cancellable.connection?.stream;
  requestWireCancellation(cancellable);
  try {
    client.release(error);
  } finally {
    stream?.destroy();
  }
}
