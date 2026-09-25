import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase, MIGRATIONS_DIRECTORY } from '../src/migrations.js';
import {
  assertBetterAuthCutoverReady,
  inspectBetterAuthCutover,
} from '../src/identity/better-auth-cutover-preflight.js';
import { createDisposableDatabaseFixture } from './support/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const database = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: ['pertexo_migration', 'pertexo_api'],
  databaseName: `pertexo_test_auth_cutover_${randomUUID().replaceAll('-', '')}`,
  ownerRole: 'pertexo_owner',
});
const migrationConfig = {
  apiRuntimeRole: 'pertexo_api',
  connectionString: database.databaseUrl(migrationBaseUrl),
  dispatcherRole: 'pertexo_dispatcher',
  lifecycleCommandRole: 'pertexo_lifecycle_command',
  maintenanceRole: 'pertexo_maintenance',
  operatorRole: 'pertexo_operator',
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;

beforeAll(database.create, 30_000);
afterAll(database.drop);

describe('Better Auth cutover migration rehearsal', () => {
  it('preserves stable identities and activates mail, session revocation, and owned proofs through 0105', async () => {
    const priorDirectory = await mkdtemp(
      path.join(tmpdir(), 'pertexo-auth-prior-head-'),
    );
    const userId = randomUUID();
    const identityId = randomUUID();
    const sessionId = randomUUID();
    try {
      const migrations = (await readdir(MIGRATIONS_DIRECTORY)).filter(
        (name) => /^\d{4}_.+\.sql$/u.test(name) && name < '0101_',
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
        connectionString: database.databaseUrl(adminUrl),
        max: 1,
      });
      try {
        await owner.query('set role pertexo_owner');
        await owner.query(
          `insert into app.users(id,email,display_name)
           values($1,'cutover@example.test','Cutover User')`,
          [userId],
        );
        await owner.query(
          `insert into app.auth_identities(id,user_id,issuer,provider_subject)
           values($1,$2,'https://legacy-idp.example.test','stable-subject')`,
          [identityId, userId],
        );
        await owner.query(
          `insert into app.sessions(id,user_id,token_digest,expires_at)
           values($1,$2,$3,clock_timestamp()+interval '1 day')`,
          [sessionId, userId, 'a'.repeat(64)],
        );
      } finally {
        await owner.end();
      }

      expect(await migrateDatabase(migrationConfig)).toEqual([
        '0101_better_auth_foundation.sql',
        '0102_better_auth_session_lifecycle.sql',
        '0103_durable_authentication_mail.sql',
        '0104_auth_email_change_session_revocation.sql',
        '0105_owned_auth_email_proofs.sql',
        '0106_auth_method_link_attempts.sql',
        '0107_legacy_method_migration_attempts.sql',
        '0108_workflow_name_revision.sql',
        '0113_workflow_run_statistics_index.sql',
        '0115_webhook_delivery_log.sql',
      ]);

      const verifier = new Pool({
        connectionString: database.databaseUrl(adminUrl),
        max: 1,
      });
      try {
        const result = await verifier.query<{
          email: string;
          identity_count: string;
          legacy_revoked: boolean;
          native_account_count: string;
        }>(
          `select users.email,
                  (select count(*) from app.auth_identities where user_id=users.id) identity_count,
                  (select revoked_at is not null from app.sessions where id=$2) legacy_revoked,
                  (select count(*) from app.auth_accounts where user_id=users.id) native_account_count
             from app.users users where users.id=$1`,
          [userId, sessionId],
        );
        expect(result.rows[0]).toEqual({
          email: 'cutover@example.test',
          identity_count: '1',
          legacy_revoked: true,
          native_account_count: '0',
        });
        const history = await verifier.query<{ name: string }>(
          `select name from pertexo_internal.schema_migrations
            where name in ('0101_better_auth_foundation.sql','0102_better_auth_session_lifecycle.sql',
                           '0103_durable_authentication_mail.sql','0104_auth_email_change_session_revocation.sql',
                           '0105_owned_auth_email_proofs.sql',
                           '0106_auth_method_link_attempts.sql',
                           '0107_legacy_method_migration_attempts.sql')
            order by name`,
        );
        expect(history.rows.map((row) => row.name)).toEqual([
          '0101_better_auth_foundation.sql',
          '0102_better_auth_session_lifecycle.sql',
          '0103_durable_authentication_mail.sql',
          '0104_auth_email_change_session_revocation.sql',
          '0105_owned_auth_email_proofs.sql',
          '0106_auth_method_link_attempts.sql',
          '0107_legacy_method_migration_attempts.sql',
        ]);
        await verifier.query(
          `insert into app.auth_sessions(id,expires_at,token,user_id)
           values($1,clock_timestamp()+interval '1 hour',$2,$3)`,
          [randomUUID(), randomUUID(), userId],
        );
      } finally {
        await verifier.end();
      }

      const migrationReader = new Pool({
        connectionString: database.databaseUrl(migrationBaseUrl),
        max: 1,
      });
      try {
        const client = await migrationReader.connect();
        try {
          await client.query('set role pertexo_owner');
          const preflight = await inspectBetterAuthCutover(client);
          expect(preflight).toEqual({
            activeUsersWithoutNativeMethod: 1,
            activeUsersWithUnmigratedLegacyIdentity: 1,
            liveLegacySessions: 0,
          });
          expect(() => {
            assertBetterAuthCutoverReady(preflight);
          }).toThrow(
            'Authentication cutover requires verified legacy-account recovery',
          );
          await client.query(
            `insert into app.auth_accounts(id,account_id,provider_id,user_id)
             values($1,$2,'google',$3)`,
            [randomUUID(), `direct-${userId}`, userId],
          );
          await client.query(
            `update app.auth_identities
                set native_method_verified_at=clock_timestamp()
              where user_id=$1`,
            [userId],
          );
          const migrated = await inspectBetterAuthCutover(client);
          expect(migrated).toEqual({
            activeUsersWithoutNativeMethod: 0,
            activeUsersWithUnmigratedLegacyIdentity: 0,
            liveLegacySessions: 0,
          });
          expect(() => {
            assertBetterAuthCutoverReady(migrated);
          }).not.toThrow();
        } finally {
          await client.query('reset role').catch(() => undefined);
          client.release();
        }
      } finally {
        await migrationReader.end();
      }

      const api = new Pool({
        connectionString: database.databaseUrl(
          process.env.DATABASE_API_URL ??
            'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo',
        ),
        max: 1,
      });
      try {
        await api.query(
          `update app.users set email='after-cutover@example.test' where id=$1`,
          [userId],
        );
        await api.query(
          `select app.enqueue_authentication_mail(
             $1,'verification',clock_timestamp()+interval '1 hour',
             'sealed-fixture','nonce','tag','v1')`,
          [randomUUID()],
        );
      } finally {
        await api.end();
      }

      const postUpgrade = new Pool({
        connectionString: database.databaseUrl(adminUrl),
        max: 1,
      });
      try {
        const result = await postUpgrade.query<{
          email: string;
          session_count: number;
          mail_count: number;
        }>(
          `select users.email,
                  (select count(*)::integer from app.auth_sessions where user_id=users.id) session_count,
                  (select count(*)::integer from app.authentication_mail_deliveries) mail_count
             from app.users users where users.id=$1`,
          [userId],
        );
        expect(result.rows).toEqual([
          {
            email: 'after-cutover@example.test',
            session_count: 0,
            mail_count: 1,
          },
        ]);
      } finally {
        await postUpgrade.end();
      }

      expect(await migrateDatabase(migrationConfig)).toEqual([]);
    } finally {
      await rm(priorDirectory, { recursive: true, force: true });
    }
  }, 60_000);
});
