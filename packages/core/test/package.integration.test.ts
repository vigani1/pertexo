import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { maintenanceUrl } from './lifecycle/retention.support.js';

it('the built lifecycle entry pauses erasure outside a transaction and releases after failure', async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
    import { withBackupDeletionPause } from '@pertexo/core/lifecycle';
    import pg from 'pg';
    import { parseDatabaseConfig } from '@pertexo/database/platform';
    const pool = new pg.Pool({ connectionString: process.env.BACKUP_TEST_DATABASE, max: 2 });
    const observer = await pool.connect();
    const key = "hashtextextended('pertexo.backup.artifact-deletion',0)";
    const result = {};
    try {
      await withBackupDeletionPause(parseDatabaseConfig({ connectionString: process.env.BACKUP_TEST_DATABASE, max: 1 }), async () => {
        result.locked = (await observer.query('select pg_try_advisory_lock_shared(' + key + ') acquired')).rows[0].acquired;
        result.state = (await observer.query("select a.state from pg_stat_activity a join pg_locks l on l.pid=a.pid where l.locktype='advisory' and l.mode='ExclusiveLock' and l.granted and a.datname=current_database()")).rows[0].state;
        throw new Error('copy failed');
      });
    } catch (error) { result.error = error.message; }
    result.released = (await observer.query('select pg_try_advisory_lock_shared(' + key + ') acquired')).rows[0].acquired;
    observer.release(true);
    await pool.end();
    console.log(JSON.stringify(result));
  `,
    ],
    {
      cwd: import.meta.dirname + '/..',
      env: { ...process.env, BACKUP_TEST_DATABASE: maintenanceUrl },
      timeout: 20000,
    },
  );
  expect(JSON.parse(stdout)).toEqual({
    locked: false,
    state: 'idle',
    error: 'copy failed',
    released: true,
  });
});
