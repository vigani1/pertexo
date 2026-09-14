import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateDatabase, MIGRATIONS_DIRECTORY } from '../src/migrations.js';
import { createDisposableDatabaseFixture } from './support/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiBaseUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const databaseName = `pertexo_test_oidc_lock_${randomUUID().replaceAll('-', '')}`;
const database = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: ['pertexo_migration', 'pertexo_api'],
  databaseName,
  ownerRole: 'pertexo_owner',
});
const migrationUrl = database.databaseUrl(migrationBaseUrl);
const migrationConfig = {
  apiRuntimeRole: 'pertexo_api',
  connectionString: migrationUrl,
  dispatcherRole: 'pertexo_dispatcher',
  lifecycleCommandRole: 'pertexo_lifecycle_command',
  maintenanceRole: 'pertexo_maintenance',
  operatorRole: 'pertexo_operator',
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;

beforeAll(database.create, 30_000);
afterAll(database.drop);

const oidcInsert = `insert into app.oidc_login_transactions
  (state_digest,code_verifier_ciphertext,code_verifier_nonce,
   code_verifier_tag,code_verifier_key_version,nonce_ciphertext,
   nonce_nonce,nonce_tag,nonce_key_version,expires_at)
 values($1,'sealed-verifier','nonce','tag','v1','sealed-nonce',
        'nonce','tag','v1',clock_timestamp()+interval '5 minutes')`;

async function waitForAdvisoryLock(
  observer: PoolClient,
  backendPid: number,
): Promise<number> {
  const startedAt = Date.now();
  const deadline = startedAt + 3_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ waiting: boolean }>(
      `select exists(
         select 1 from pg_stat_activity
          where pid=$1 and wait_event_type='Lock' and wait_event='advisory'
       ) waiting`,
      [backendPid],
    );
    if (result.rows[0]?.waiting === true) return Date.now() - startedAt;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('OIDC admission did not wait on the advisory lock');
}

async function waitUntilExpired(observer: PoolClient, expiresAt: Date) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ expired: boolean }>(
      'select clock_timestamp()>=$1::timestamptz expired',
      [expiresAt],
    );
    if (result.rows[0]?.expired === true) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('OIDC boundary row did not expire within the test budget');
}

async function addBoundaryRow(owner: PoolClient, marker: string) {
  await owner.query('begin');
  try {
    await owner.query('set local role pertexo_owner');
    await owner.query(
      'alter table app.oidc_login_transactions disable trigger oidc_login_transactions_capacity',
    );
    const result = await owner.query<{ expires_at: Date }>(
      `insert into app.oidc_login_transactions
        (state_digest,code_verifier_ciphertext,code_verifier_nonce,
         code_verifier_tag,code_verifier_key_version,nonce_ciphertext,
         nonce_nonce,nonce_tag,nonce_key_version,expires_at)
       values($1,'sealed-verifier','nonce','tag','v1','sealed-nonce',
              'nonce','tag','v1',clock_timestamp()+interval '1 second')
       returning expires_at`,
      [marker.repeat(64)],
    );
    await owner.query(
      'alter table app.oidc_login_transactions enable trigger oidc_login_transactions_capacity',
    );
    await owner.query('commit');
    const expiresAt = result.rows[0]?.expires_at;
    if (expiresAt === undefined)
      throw new Error('Boundary row was not inserted');
    return expiresAt;
  } catch (error: unknown) {
    await owner.query('rollback').catch(() => undefined);
    throw error;
  }
}

async function contendAtExpiry(input: {
  api: PoolClient;
  holder: PoolClient;
  marker: string;
  observer: PoolClient;
  owner: PoolClient;
}) {
  const expiresAt = await addBoundaryRow(input.owner, input.marker);
  await input.holder.query('begin');
  await input.holder.query('select pg_advisory_xact_lock(7166118815)');
  const pid = await input.api.query<{ pid: number }>(
    'select pg_backend_pid() pid',
  );
  const stateDigest = randomUUID().replaceAll('-', '').padEnd(64, '0');
  const admission = input.api.query(oidcInsert, [stateDigest]);
  const observedWaitMs = await waitForAdvisoryLock(
    input.observer,
    pid.rows[0]?.pid ?? -1,
  );
  await waitUntilExpired(input.observer, expiresAt);
  await input.holder.query('commit');
  return { admission, observedWaitMs, stateDigest };
}

describe('OIDC capacity lock-time migration', () => {
  it('reproduces stale admission time at 0010 and repairs it forward', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pertexo-oidc-lock-'));
    const ownerPool = new Pool({ connectionString: migrationUrl, max: 1 });
    const apiPool = new Pool({
      connectionString: database.databaseUrl(apiBaseUrl),
      max: 1,
    });
    const observerPool = new Pool({
      connectionString: database.databaseUrl(adminUrl),
      max: 1,
    });
    const holderPool = new Pool({ connectionString: migrationUrl, max: 1 });
    const clients: PoolClient[] = [];
    try {
      const migrations = (await readdir(MIGRATIONS_DIRECTORY)).filter(
        (name) =>
          /^\d{4}_.+\.sql$/u.test(name) &&
          name <= '0010_oidc_transaction_capacity.sql',
      );
      await Promise.all(
        migrations.map((name) =>
          copyFile(
            path.join(MIGRATIONS_DIRECTORY, name),
            path.join(directory, name),
          ),
        ),
      );
      expect((await migrateDatabase(migrationConfig, directory)).at(-1)).toBe(
        '0010_oidc_transaction_capacity.sql',
      );

      const [owner, api, observer, holder] = await Promise.all([
        ownerPool.connect(),
        apiPool.connect(),
        observerPool.connect(),
        holderPool.connect(),
      ]);
      clients.push(owner, api, observer, holder);
      await owner.query('begin');
      try {
        await owner.query('set local role pertexo_owner');
        await owner.query(
          'alter table app.oidc_login_transactions disable trigger oidc_login_transactions_capacity',
        );
        await owner.query(
          `insert into app.oidc_login_transactions
            (state_digest,code_verifier_ciphertext,code_verifier_nonce,
             code_verifier_tag,code_verifier_key_version,nonce_ciphertext,
             nonce_nonce,nonce_tag,nonce_key_version,expires_at)
           select md5(series::text)||md5('active-'||series::text),
                  'sealed-verifier','nonce','tag','v1','sealed-nonce',
                  'nonce','tag','v1',clock_timestamp()+interval '1 hour'
             from generate_series(1,9999) series`,
        );
        await owner.query(
          'alter table app.oidc_login_transactions enable trigger oidc_login_transactions_capacity',
        );
        await owner.query('commit');
      } catch (error: unknown) {
        await owner.query('rollback').catch(() => undefined);
        throw error;
      }

      const historical = await contendAtExpiry({
        api,
        holder,
        marker: 'a',
        observer,
        owner,
      });
      await expect(historical.admission).rejects.toMatchObject({
        code: '54000',
      });
      expect(historical.observedWaitMs).toBeGreaterThanOrEqual(0);
      const historicalCounts = await observer.query<{
        admitted: string;
        total: string;
      }>(
        `select count(*) filter(where state_digest=$1)::text admitted,
                count(*)::text total from app.oidc_login_transactions`,
        [historical.stateDigest],
      );
      expect(historicalCounts.rows).toEqual([
        { admitted: '0', total: '10000' },
      ]);

      await copyFile(
        path.join(MIGRATIONS_DIRECTORY, '0089_oidc_capacity_lock_time.sql'),
        path.join(directory, '0089_oidc_capacity_lock_time.sql'),
      );
      await expect(
        migrateDatabase(migrationConfig, directory),
      ).resolves.toEqual(['0089_oidc_capacity_lock_time.sql']);

      const repaired = await contendAtExpiry({
        api,
        holder,
        marker: 'b',
        observer,
        owner,
      });
      await expect(repaired.admission).resolves.toMatchObject({ rowCount: 1 });
      const repairedCounts = await observer.query<{
        active: string;
        admitted: string;
        total: string;
      }>(
        `select count(*) filter(where consumed_at is null and expires_at>clock_timestamp())::text active,
                count(*) filter(where state_digest=$1)::text admitted,
                count(*)::text total from app.oidc_login_transactions`,
        [repaired.stateDigest],
      );
      expect(repairedCounts.rows).toEqual([
        { active: '10000', admitted: '1', total: '10002' },
      ]);

      const catalog = await observer.query<{
        owner: string;
        proconfig: string[];
        prosecdef: boolean;
        public_execute: boolean;
        trigger_enabled: string;
      }>(`
        select pg_get_userbyid(proc.proowner) owner,proc.prosecdef,proc.proconfig,
               exists(
                 select 1
                   from aclexplode(coalesce(proc.proacl,acldefault('f',proc.proowner))) acl
                  where acl.grantee=0 and acl.privilege_type='EXECUTE'
               ) public_execute,
               trigger.tgenabled trigger_enabled
          from pg_proc proc
          join pg_namespace namespace on namespace.oid=proc.pronamespace
          join pg_trigger trigger on trigger.tgfoid=proc.oid
         where namespace.nspname='app'
           and proc.proname='enforce_oidc_login_transaction_capacity'
           and trigger.tgname='oidc_login_transactions_capacity'
      `);
      expect(catalog.rows).toEqual([
        {
          owner: 'pertexo_owner',
          proconfig: ['search_path=pg_catalog, pg_temp'],
          prosecdef: true,
          public_execute: false,
          trigger_enabled: 'O',
        },
      ]);
    } finally {
      await Promise.allSettled(
        clients.map((client) => client.query('rollback')),
      );
      for (const client of clients) client.release(true);
      await Promise.allSettled([
        ownerPool.end(),
        apiPool.end(),
        observerPool.end(),
        holderPool.end(),
        rm(directory, { recursive: true, force: true }),
      ]);
    }
  }, 30_000);
});
