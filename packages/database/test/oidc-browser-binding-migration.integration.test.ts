import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase, MIGRATIONS_DIRECTORY } from '../src/migrations.js';
import { createDisposableDatabaseFixture } from './support/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const databaseName = `pertexo_test_0071_oidc_binding_${randomUUID().replaceAll('-', '')}`;

const database = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: ['pertexo_migration', 'pertexo_api'],
  databaseName,
  ownerRole: 'pertexo_owner',
});
const { databaseUrl } = database;

const migrationConfig = {
  apiRuntimeRole: 'pertexo_api',
  connectionString: databaseUrl(migrationBaseUrl),
  dispatcherRole: 'pertexo_dispatcher',
  lifecycleCommandRole: 'pertexo_lifecycle_command',
  maintenanceRole: 'pertexo_maintenance',
  operatorRole: 'pertexo_operator',
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;

beforeAll(database.create, 30_000);
afterAll(database.drop);

describe('OIDC browser binding prior-head migration', () => {
  it('upgrades populated 0070 transactions without leaving them reusable', async () => {
    const priorDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-0070-oidc-binding-'),
    );
    try {
      const migrations = (await readdir(MIGRATIONS_DIRECTORY)).filter(
        (name) => /^\d{4}_.+\.sql$/u.test(name) && name < '0071_',
      );
      await Promise.all(
        migrations.map((name) =>
          copyFile(
            path.join(MIGRATIONS_DIRECTORY, name),
            path.join(priorDirectory, name),
          ),
        ),
      );
      await migrateDatabase(migrationConfig, priorDirectory);

      const owner = new Pool({
        connectionString: databaseUrl(adminUrl),
        max: 1,
      });
      const stateDigest = '1'.repeat(64);
      try {
        await owner.query('set role pertexo_owner');
        await owner.query(
          `insert into app.oidc_login_transactions
             (state_digest, code_verifier_ciphertext, code_verifier_nonce,
              code_verifier_tag, code_verifier_key_version, nonce_ciphertext,
              nonce_nonce, nonce_tag, nonce_key_version, expires_at)
           values ($1, 'sealed-verifier', 'nonce', 'tag', 'v1',
                   'sealed-nonce', 'nonce', 'tag', 'v1',
                   clock_timestamp() + interval '5 minutes')`,
          [stateDigest],
        );
      } finally {
        await owner.end();
      }

      expect(await migrateDatabase(migrationConfig)).toEqual([
        '0071_oidc_browser_binding.sql',
        '0072_regional_replica_identity.sql',
        '0073_transient_data_retention.sql',
        '0074_retention_schedule_state_rls.sql',
        '0075_workspace_purge_step_release.sql',
        '0076_replay_lineage_retention.sql',
        '0077_replay_read_locks.sql',
        '0078_workflow_lifecycle_revision.sql',
        '0079_artifact_upload_capacity.sql',
        '0080_expired_artifact_upload_retention.sql',
      ]);

      const verifier = new Pool({
        connectionString: databaseUrl(adminUrl),
        max: 1,
      });
      try {
        const row = await verifier.query<{
          browser_binding_digest: string;
          consumed_at: Date | null;
        }>(
          `select browser_binding_digest, consumed_at
           from app.oidc_login_transactions where state_digest = $1`,
          [stateDigest],
        );
        expect(row.rows[0]?.browser_binding_digest).toBe('0'.repeat(64));
        expect(row.rows[0]?.consumed_at).toBeInstanceOf(Date);
        await expect(
          verifier.query(
            `insert into app.oidc_login_transactions
               (state_digest, code_verifier_ciphertext, code_verifier_nonce,
                code_verifier_tag, code_verifier_key_version, nonce_ciphertext,
                nonce_nonce, nonce_tag, nonce_key_version, expires_at)
             values ($1, 'v', 'n', 't', 'k', 'n', 'n', 't', 'k',
                     clock_timestamp() + interval '5 minutes')`,
            ['2'.repeat(64)],
          ),
        ).rejects.toMatchObject({ code: '23502' });
      } finally {
        await verifier.end();
      }
    } finally {
      await rm(priorDirectory, { recursive: true, force: true });
    }
  }, 60_000);
});
