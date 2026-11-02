import { Client, type Pool } from 'pg';

/**
 * A connection outside the pool, with the pool's settings, for something that holds
 * one for as long as the process runs. Not connected yet; the caller connects and ends it.
 */
export function createDedicatedClient(pool: Pool): Client {
  return new Client(pool.options);
}
