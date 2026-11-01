import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  createDisposableDatabaseFixture,
  migrateDatabase,
} from '@pertexo/database/testing';

import { createPertexoBetterAuth } from '../../src/authentication/better-auth/options.js';
import { AuthenticationTransactions } from '../../src/authentication/better-auth/transactions/context.js';
import { LocalAuthenticationMailSink } from '../../src/authentication/mail/delivery.js';
import type { OwnedEmailProofs } from '../../src/authentication/mail/email-proofs.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const appUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';

const roles = ['pertexo_migration', 'pertexo_app', 'pertexo_maintenance'];
const suffix = randomUUID().replaceAll('-', '');
const migrated = `pertexo_test_auth_schema_${suffix}`;
const empty = `pertexo_test_auth_empty_${suffix}`;
const fixtures = [migrated, empty].map((databaseName) =>
  createDisposableDatabaseFixture({
    adminUrl,
    databaseName,
    ownerRole: 'pertexo_owner',
    connectRoles: roles,
  }),
);
const url = (base: string, database: string) => {
  const value = new URL(base);
  value.pathname = `/${database}`;
  return value.toString();
};

const pools: Pool[] = [];
const poolFor = (database: string) => {
  const pool = new Pool({ connectionString: url(appUrl, database), max: 2 });
  pools.push(pool);
  return pool;
};

function boot(database: string, security: boolean) {
  return createPertexoBetterAuth({
    pool: poolFor(database),
    baseUrl: 'http://127.0.0.1:5173',
    secret: 'schema-check-secret-with-at-least-32-characters',
    secureCookies: false,
    sessionTtlSeconds: 3_600,
    trustedOrigins: [],
    mail: new LocalAuthenticationMailSink(),
    emailProofs: {} as OwnedEmailProofs,
    availableLinkProviders: [],
    ...(security ? { transactions: new AuthenticationTransactions() } : {}),
  });
}

/** Whatever the check logs once the context it runs from has settled. */
async function logsOf(auth: ReturnType<typeof boot>): Promise<string> {
  const context = await auth.$context;
  await context.checkSchema?.()?.catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 100));
  return errorOutput();
}

let errors: ReturnType<typeof vi.spyOn>;
const errorOutput = () =>
  errors.mock.calls.map((call: unknown[]) => call.join(' ')).join('\n');

beforeAll(async () => {
  await Promise.all(fixtures.map((fixture) => fixture.create()));
  await migrateDatabase({
    connectionString: url(migrationUrl, migrated),
    ownerRole: 'pertexo_owner',
    appRole: 'pertexo_app',
    maintenanceRole: 'pertexo_maintenance',
  });
}, 60_000);

afterEach(() => {
  errors.mockRestore();
});

afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
  await Promise.all(fixtures.map((fixture) => fixture.drop()));
}, 30_000);

describe('the Better Auth schema check at boot', () => {
  it('reports no false error from the security instance', async () => {
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const logs = await logsOf(boot(migrated, true));

    expect(logs).not.toContain('Could not validate the database schema');
    expect(logs).not.toContain('Security changes require');
  });

  it('never runs the check on the security instance, whatever the database', async () => {
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const logs = await logsOf(boot(empty, true));

    expect(logs).toBe('');
  });

  it('passes on the plain instance against the real schema', async () => {
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const logs = await logsOf(boot(migrated, false));

    expect(logs).toBe('');
  });

  it('still checks on the plain instance: an empty database gets reported', async () => {
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const logs = await logsOf(boot(empty, false));

    expect(logs).not.toBe('');
  });
});
