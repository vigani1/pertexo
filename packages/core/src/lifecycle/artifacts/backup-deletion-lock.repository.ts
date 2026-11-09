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
      // Unlock before returning so erasure resumes at once: the server ends a
      // closed session asynchronously. If the unlock itself fails, closing
      // this dedicated session still releases the lock, and the work's own
      // error must not be replaced by the unlock's.
      await client
        .query(`select pg_advisory_unlock(${lock})`)
        .catch(() => undefined);
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
