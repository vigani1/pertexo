import type { Pool, PoolClient } from 'pg';

/**
 * A backend running a statement checks every second that its client is still
 * there. An abort's CancelRequest is ignored when it lands before the backend
 * has read the statement, and PostgreSQL doesn't otherwise look at the socket
 * while a statement runs, so the backend kept working, holding its
 * connection and locks, for the statement's whole length after the client
 * had gone. A session setting, not a startup option: pg lets an `options` in
 * the connection string replace it, and it would replace PGOPTIONS.
 */
// session-setting-exempt: every connection of every pool sets the same value before its first use, so nothing carries from one transaction to the next
const CHECK_CLIENT_CONNECTION = 'set client_connection_check_interval = 1000';

type ConnectCallback = (
  error: Error | undefined,
  client: PoolClient | undefined,
  release: (destroy?: boolean | Error) => void,
) => void;

/**
 * Sets the check on each new connection and waits for it before the first
 * caller gets the client. Sent from the connect event instead, the caller's
 * first query queued behind it, which pg warns about on stderr (and a
 * release preflight that requires a clean stderr then failed). A failure
 * is reported and the client still handed out, as before.
 */
export function checkClientConnection(
  pool: Pool,
  onFailure: (error: unknown) => void,
): void {
  const pending = new WeakMap<PoolClient, () => Promise<unknown>>();
  // Captured before telemetry wraps query, so the setup isn't counted.
  pool.on('connect', (client) => {
    const send = client.query.bind(client) as (
      text: string,
    ) => Promise<unknown>;
    pending.set(client, () => send(CHECK_CLIENT_CONNECTION));
  });
  const prepare = async (client: PoolClient): Promise<void> => {
    const check = pending.get(client);
    if (check === undefined) return;
    pending.delete(client);
    try {
      await check();
    } catch (error: unknown) {
      onFailure(error);
    }
  };
  // pg's two overloads of the same checkout, captured before it is wrapped.
  const bound = pool.connect.bind(pool);
  const connect = bound as () => Promise<PoolClient>;
  const connectWith = bound as (callback: ConnectCallback) => void;
  pool.connect = ((callback?: ConnectCallback): unknown => {
    if (callback === undefined)
      return connect().then(async (client) => {
        await prepare(client);
        return client;
      });
    connectWith((error, client, release) => {
      if (error !== undefined || client === undefined) {
        callback(error, client, release);
        return;
      }
      void prepare(client).then(() => {
        callback(undefined, client, release);
      });
    });
    return undefined;
  }) as Pool['connect'];
}
