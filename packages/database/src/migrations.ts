import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import type { MigrationConfig } from './config.js';

const MIGRATION_LOCK_ID = 7_166_118_812;
const migrationNamePattern = /^\d{4}_[a-z0-9_]+\.sql$/u;

export const MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL('../migrations/', import.meta.url),
);

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export async function migrateDatabase(
  config: MigrationConfig,
  migrationsDirectory = MIGRATIONS_DIRECTORY,
): Promise<readonly string[]> {
  const pool = new Pool({ connectionString: config.connectionString, max: 1 });
  const client = await pool.connect();
  const applied: string[] = [];

  try {
    await client.query('begin');
    await client.query(`set local role ${quoteIdentifier(config.ownerRole)}`);
    const roleResult = await client.query<{ current_user: string }>(
      'select current_user',
    );
    if (roleResult.rows[0]?.current_user !== config.ownerRole) {
      throw new Error('Migration owner role verification failed');
    }

    await client.query('select pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query('create schema if not exists pertexo_internal');
    await client.query('revoke all on schema pertexo_internal from public');
    await client.query(`
      create table if not exists pertexo_internal.schema_migrations (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `);

    const migrationNames = (await readdir(migrationsDirectory))
      .filter((name) => migrationNamePattern.test(name))
      .sort();

    for (const name of migrationNames) {
      const sql = await readFile(path.join(migrationsDirectory, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query<{ checksum: string }>(
        'select checksum from pertexo_internal.schema_migrations where name = $1',
        [name],
      );

      if (existing.rows[0] !== undefined) {
        if (existing.rows[0].checksum !== checksum) {
          throw new Error(`Applied migration checksum changed: ${name}`);
        }
        continue;
      }

      await client.query(sql);
      await client.query(
        'insert into pertexo_internal.schema_migrations (name, checksum) values ($1, $2)',
        [name, checksum],
      );
      applied.push(name);
    }

    await client.query(
      'grant usage on schema pertexo_internal to pertexo_api, pertexo_worker',
    );
    await client.query(
      'grant select on pertexo_internal.schema_migrations to pertexo_api, pertexo_worker',
    );
    await client.query('commit');
    return Object.freeze(applied);
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
