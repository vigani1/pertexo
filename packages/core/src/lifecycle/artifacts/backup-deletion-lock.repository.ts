import type { Pool } from 'pg';
import {
  acquireDatabasePool,
  type DatabaseConfig,
} from '@pertexo/database/platform';

const lock = "hashtextextended('pertexo.backup.artifact-deletion',0)";

/** Hold a session lock, without a transaction, until the matched copy is safe. */
export async function withBackupDeletionPause<T>(
  config: DatabaseConfig,
  work: () => Promise<T>,
): Promise<T> {
  const lease = acquireDatabasePool(config, undefined, { role: 'maintenance' });
  try {
    const client = await lease.pool.connect();
    try {
      await client.query(`select pg_advisory_lock(${lock})`);
      return await work();
    } finally {
      // Closing this dedicated session also releases the lock on any failure.
      client.release(true);
    }
  } finally {
    await lease.close();
  }
}

/** Defer erasure instead of waiting behind an online backup. */
export async function withArtifactErasure<T>(
  pool: Pool,
  work: () => Promise<T>,
): Promise<T | undefined> {
  const client = await pool.connect();
  let failed = false;
  try {
    const result = await client.query<{ acquired: boolean }>(
      `select pg_try_advisory_lock_shared(${lock}) acquired`,
    );
    if (result.rows[0]?.acquired !== true) return undefined;
    try {
      return await work();
    } finally {
      await client.query(`select pg_advisory_unlock_shared(${lock})`);
    }
  } catch (error: unknown) {
    failed = true;
    throw error;
  } finally {
    client.release(failed);
  }
}
