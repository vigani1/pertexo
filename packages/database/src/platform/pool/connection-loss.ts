import type { Pool } from 'pg';

/**
 * PostgreSQL ends connections on a restart or failover, and an error event
 * nobody listens for ends the whole process. A pool listens only while a
 * connection is idle, so one that is checked out needs its own listener. The
 * holder still learns: its next query fails, and release drops the connection.
 */
export function surviveConnectionLoss(
  pool: Pool,
  onIdleLost: (error: Error) => void = () => undefined,
): void {
  pool.on('error', onIdleLost);
  pool.on('connect', (client) => {
    client.on('error', () => undefined);
  });
}
