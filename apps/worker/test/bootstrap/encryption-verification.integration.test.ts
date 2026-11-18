import { testStackSetting } from '../../../../infrastructure/testing/test-stack.mjs';
import { createHash, randomUUID } from 'node:crypto';

import {
  createConnectionStore,
  createIdentityWorkspaceStore,
} from '@pertexo/core/testing';
import {
  createDisposableDatabaseFixture,
  migrateDatabase,
  parseDatabaseConfig,
} from '@pertexo/database/testing';
import type { StructuredLogger } from '@pertexo/observability/server';
import type { TelemetryLifecycle } from '@pertexo/observability/startup';
import { createConnectionEnvelopeEncryption } from '@pertexo/secrets/server';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { parseWorkerConfig } from '../../src/config/worker.js';
import { createWorkerApplication } from '../../src/worker-application.js';
import { workerEnvironment } from '../support/worker-environment.js';

// A database of its own: a credential sealed with a key the worker lacks
// would stop every other worker that starts against a shared one.
const fixture = createDisposableDatabaseFixture({
  adminUrl: testStackSetting('DATABASE_ADMIN_URL'),
  connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_maintenance'],
  databaseName: `pertexo_test_startup_keys_${randomUUID().replaceAll('-', '')}`,
  ownerRole: 'pertexo_owner',
});
const url = (variable: string, applicationName?: string) => {
  const value = new URL(fixture.databaseUrl(testStackSetting(variable)));
  if (applicationName !== undefined)
    value.searchParams.set('application_name', applicationName);
  return value.toString();
};

const storedKey = Buffer.alloc(32, 7).toString('base64');

beforeAll(async () => {
  await fixture.create();
  await migrateDatabase({
    appRole: 'pertexo_app',
    connectionString: url('DATABASE_MIGRATION_URL'),
    maintenanceRole: 'pertexo_maintenance',
    ownerRole: 'pertexo_owner',
  });
  await storeConnectionSealedWith(storedKey);
});

afterAll(async () => {
  await fixture.drop();
});

/** A workspace connection whose credential was sealed with `key`, version 1. */
async function storeConnectionSealedWith(key: string) {
  const config = parseDatabaseConfig({
    connectionString: url('DATABASE_URL'),
    max: 1,
  });
  const identity = createIdentityWorkspaceStore(config);
  const connections = createConnectionStore(config);
  const encryption = createConnectionEnvelopeEncryption({
    mode: 'self-managed',
    encryption: { current: { version: '1', key }, previous: [] },
  });
  try {
    const actorId = (
      await identity.createUser({
        email: `${randomUUID()}@example.test`,
        displayName: 'Owner',
      })
    ).id;
    const workspaceId = (
      await identity.createWorkspaceWithOwner({
        name: 'Startup keys',
        slug: `startup-keys-${randomUUID().slice(0, 8)}`,
        ownerUserId: actorId,
      })
    ).id;
    const connectionId = randomUUID();
    const secretVersionId = randomUUID();
    await connections.createConnection({
      workspaceId,
      actorId,
      connectionId,
      secretVersionId,
      providerKey: 'http',
      name: 'Sealed with the old key',
      authType: 'http_headers',
      sealed: await encryption.encryption.seal(
        new TextEncoder().encode(
          JSON.stringify({
            type: 'http_headers',
            headers: { authorization: 'Bearer stored' },
          }),
        ),
        { workspaceId, connectionId, secretVersionId },
      ),
      idempotencyKey: randomUUID(),
      requestHash: createHash('sha256').update(randomUUID()).digest('hex'),
    });
  } finally {
    encryption.close();
    await Promise.all([identity.close(), connections.close()]);
  }
}

/** Database sessions this worker process opened, found by their name. */
async function sessionsNamed(applicationName: string): Promise<number> {
  const admin = new Pool({
    connectionString: testStackSetting('DATABASE_ADMIN_URL'),
    max: 1,
  });
  try {
    const { rows } = await admin.query<{ count: number }>(
      'select count(*)::int as count from pg_stat_activity where application_name = $1',
      [applicationName],
    );
    return rows[0]?.count ?? 0;
  } finally {
    await admin.end();
  }
}

it('refuses to start, and holds no database session, when it cannot open a stored credential', async () => {
  const applicationName = `worker-startup-keys-${randomUUID()}`;
  const silent = {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  } satisfies StructuredLogger;
  const telemetry = {
    enabled: false,
    started: false,
    start: vi.fn(),
    shutdown: vi.fn(() => Promise.resolve()),
  } satisfies TelemetryLifecycle;
  const config = parseWorkerConfig({
    // The fixture's settings fill whatever the test stack leaves unset.
    ...workerEnvironment,
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: url('DATABASE_URL', applicationName),
    DATABASE_MAINTENANCE_URL: url('DATABASE_MAINTENANCE_URL', applicationName),
    CONNECTION_ENCRYPTION_MODE: 'self-managed',
    // Same version, other key: the stored credential cannot be opened.
    CONNECTION_SELF_MANAGED_KEY: Buffer.alloc(32, 8).toString('base64'),
    CONNECTION_SELF_MANAGED_KEY_VERSION: '1',
  });

  const outcome: unknown = await createWorkerApplication(config, {
    logger: silent,
    telemetry,
  }).then(
    async (application) => {
      await application.close();
      return 'started';
    },
    (error: unknown) => error,
  );

  expect(outcome).toMatchObject({ code: 'unavailable_key_material' });
  expect(await sessionsNamed(applicationName)).toBe(0);
});
