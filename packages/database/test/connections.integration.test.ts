import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Pool } from 'pg';
import type { DatabaseError } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CONNECTION_AUTH_TYPE,
  ConnectionConflictError,
  ConnectionIdempotencyConflictError,
  ConnectionSecretVersionConflictError,
  ConnectionUnavailableError,
  createConnectionDatabase,
  type ConnectionDatabase,
  type CreateConnectionInput,
} from '../src/connections.js';
import { parseDatabaseConfig } from '../src/config.js';
import { migrateDatabase, MIGRATIONS_DIRECTORY } from '../src/migrations.js';
import { checkDatabaseReadiness } from '../src/readiness.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiBaseUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const workerBaseUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';
const databaseName = `pertexo_test_connections_${randomUUID().replaceAll('-', '')}`;
const upgradeDatabaseName = `pertexo_test_connections_upgrade_${randomUUID().replaceAll('-', '')}`;
const workspaceA = randomUUID();
const workspaceB = randomUUID();
const ownerA = randomUUID();
const ownerB = randomUUID();

let api: ConnectionDatabase;
let worker: ConnectionDatabase;
let closeResources = (): Promise<void> => Promise.resolve();
let upgradeApplied: readonly string[] = [];

function databaseUrl(base: string, name = databaseName): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

function pgCode(expected: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    let current: unknown = error;
    while (current instanceof Error) {
      if ((current as DatabaseError).code === expected) return true;
      current = current.cause;
    }
    return false;
  };
}

async function createDatabase(name: string): Promise<void> {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`drop database if exists "${name}" with (force)`);
    await admin.query(`create database "${name}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${name}" from public`);
    await admin.query(
      `grant connect on database "${name}" to pertexo_migration, pertexo_api, pertexo_worker, pertexo_dispatcher`,
    );
  } finally {
    await admin.end();
  }
}

async function dropDatabase(name: string): Promise<void> {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`drop database if exists "${name}" with (force)`);
  } finally {
    await admin.end();
  }
}

function migrationConfig(name = databaseName) {
  return {
    apiRuntimeRole: 'pertexo_api',
    connectionString: databaseUrl(migrationBaseUrl, name),
    dispatcherRole: 'pertexo_dispatcher',
    ownerRole: 'pertexo_owner',
    workerRuntimeRole: 'pertexo_worker',
  } as const;
}

async function migrateThrough0019(name: string): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'pertexo-0019-'));
  try {
    const migrations = (await readdir(MIGRATIONS_DIRECTORY)).filter(
      (migration) => /^\d{4}_.+\.sql$/u.test(migration) && migration < '0020_',
    );
    await Promise.all(
      migrations.map((migration) =>
        copyFile(
          path.join(MIGRATIONS_DIRECTORY, migration),
          path.join(directory, migration),
        ),
      ),
    );
    await migrateDatabase(migrationConfig(name), directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function seedWorkspaces(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    for (const [workspaceId, ownerId, suffix] of [
      [workspaceA, ownerA, 'a'],
      [workspaceB, ownerB, 'b'],
    ] as const) {
      await client.query(
        `insert into app.users (id, email, display_name, status)
         values ($1, $2, $3, 'active')`,
        [ownerId, `connection-${suffix}@example.test`, `Owner ${suffix}`],
      );
      await client.query(
        `insert into app.workspaces
           (id, name, slug, status, created_by)
         values ($1, $2, $3, 'active', $4)`,
        [workspaceId, `Workspace ${suffix}`, `connection-${suffix}`, ownerId],
      );
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceId,
      ]);
      await client.query(
        `insert into app.workspace_memberships
           (workspace_id, user_id, role, status)
         values ($1, $2, 'owner', 'active')`,
        [workspaceId, ownerId],
      );
    }
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

const sealed = (marker: number) => ({
  schemaVersion: 1 as const,
  kmsKeyReference: 'arn:aws:kms:eu-central-1:123456789012:key/example',
  encryptedDataKey: Buffer.alloc(96, marker).toString('base64url'),
  ciphertext: Buffer.from(`encrypted-${String(marker)}`).toString('base64url'),
  nonce: Buffer.alloc(12, marker).toString('base64url'),
  tag: Buffer.alloc(16, marker).toString('base64url'),
});

function createInput(
  overrides: Partial<CreateConnectionInput> = {},
): CreateConnectionInput {
  const connectionId = overrides.connectionId ?? randomUUID();
  const secretVersionId = overrides.secretVersionId ?? randomUUID();
  const name = overrides.name ?? `HTTP ${connectionId.slice(0, 8)}`;
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ name, connectionId }))
    .digest('hex');
  return {
    workspaceId: workspaceA,
    actorId: ownerA,
    connectionId,
    secretVersionId,
    providerKey: 'http',
    name,
    authType: CONNECTION_AUTH_TYPE.httpHeaders,
    sealed: sealed(1),
    idempotencyKey: `create-${connectionId}`,
    requestHash,
    requestId: `request-${connectionId}`,
    traceId: `trace-${connectionId}`,
    ...overrides,
  };
}

beforeAll(async () => {
  await Promise.all([
    createDatabase(databaseName),
    createDatabase(upgradeDatabaseName),
  ]);
  await migrateDatabase(migrationConfig());
  await migrateThrough0019(upgradeDatabaseName);
  upgradeApplied = await migrateDatabase(migrationConfig(upgradeDatabaseName));
  await seedWorkspaces();
  api = createConnectionDatabase(
    parseDatabaseConfig({ connectionString: databaseUrl(apiBaseUrl), max: 4 }),
  );
  worker = createConnectionDatabase(
    parseDatabaseConfig({
      connectionString: databaseUrl(workerBaseUrl),
      max: 4,
    }),
  );
  closeResources = async (): Promise<void> => {
    await Promise.allSettled([api.close(), worker.close()]);
  };
});

afterAll(async () => {
  await closeResources();
  await Promise.all([
    dropDatabase(databaseName),
    dropDatabase(upgradeDatabaseName),
  ]);
});

describe('connection persistence', () => {
  it('upgrades the supported prior head through only the connection migration', async () => {
    expect(upgradeApplied).toEqual(['0020_connections.sql']);
    const pool = new Pool({
      connectionString: databaseUrl(apiBaseUrl, upgradeDatabaseName),
      max: 1,
    });
    try {
      await expect(
        checkDatabaseReadiness(pool, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
        }),
      ).resolves.toMatchObject({ migrationHead: '0020_connections.sql' });
    } finally {
      await pool.end();
    }
  });

  it('atomically creates one current immutable secret and replays an exact request', async () => {
    const input = createInput();
    const created = await api.createConnection(input);
    const replayed = await api.createConnection({
      ...input,
      connectionId: randomUUID(),
      secretVersionId: randomUUID(),
      sealed: sealed(2),
    });

    expect(replayed).toEqual(created);
    expect(created).toMatchObject({
      id: input.connectionId,
      workspaceId: workspaceA,
      providerKey: 'http',
      authType: 'http_headers',
      status: 'active',
      currentSecretVersionId: input.secretVersionId,
    });
    expect(JSON.stringify(created)).not.toContain('encrypted');

    const owner = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    const client = await owner.connect();
    try {
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceA,
      ]);
      const result = await client.query<{
        connection_count: string;
        event_count: string;
        secret_count: string;
        plaintext_columns: string;
      }>(
        `select
           (select count(*)::text from app.connections where id = $1) as connection_count,
           (select count(*)::text from app.connection_secret_versions where connection_id = $1) as secret_count,
           (select count(*)::text from app.connection_events where connection_id = $1) as event_count,
           (select count(*)::text from information_schema.columns
             where table_schema = 'app'
               and table_name = 'connection_secret_versions'
               and column_name ~ '(plaintext|credential|secret_value)') as plaintext_columns`,
        [input.connectionId],
      );
      expect(result.rows[0]).toEqual({
        connection_count: '1',
        event_count: '1',
        secret_count: '1',
        plaintext_columns: '0',
      });
      await client.query('commit');
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
      await owner.end();
    }
  });

  it('rejects conflicting idempotency and active provider/name reuse without partial rows', async () => {
    const input = createInput();
    await api.createConnection(input);
    await expect(
      api.createConnection({
        ...input,
        requestHash: 'f'.repeat(64),
      }),
    ).rejects.toBeInstanceOf(ConnectionIdempotencyConflictError);

    const duplicate = createInput({ name: input.name });
    await expect(api.createConnection(duplicate)).rejects.toBeInstanceOf(
      ConnectionConflictError,
    );
    const owner = new Pool({ connectionString: databaseUrl(migrationBaseUrl) });
    const client = await owner.connect();
    try {
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceA,
      ]);
      const result = await client.query<{ count: string }>(
        `select count(*)::text as count from app.connection_secret_versions
         where id = $1`,
        [duplicate.secretVersionId],
      );
      expect(result.rows[0]?.count).toBe('0');
      await client.query('commit');
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
      await owner.end();
    }
  });

  it('uses a compare-and-swap rotation and rejects cross-connection pointers', async () => {
    const first = createInput();
    const second = createInput();
    await api.createConnection(first);
    await api.createConnection(second);
    const nextSecretVersionId = randomUUID();
    const rotated = await api.rotateConnectionSecret({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: first.connectionId,
      expectedCurrentSecretVersionId: first.secretVersionId,
      secretVersionId: nextSecretVersionId,
      sealed: sealed(3),
    });
    expect(rotated.currentSecretVersionId).toBe(nextSecretVersionId);
    await expect(
      api.rotateConnectionSecret({
        workspaceId: workspaceA,
        actorId: ownerA,
        connectionId: first.connectionId,
        expectedCurrentSecretVersionId: first.secretVersionId,
        secretVersionId: randomUUID(),
        sealed: sealed(4),
      }),
    ).rejects.toBeInstanceOf(ConnectionSecretVersionConflictError);

    const pool = new Pool({ connectionString: databaseUrl(apiBaseUrl) });
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceA,
      ]);
      await client.query(
        `update app.connections set current_secret_version_id = $1
         where id = $2`,
        [second.secretVersionId, first.connectionId],
      );
      await expect(client.query('commit')).rejects.toSatisfy(pgCode('23503'));
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
      await pool.end();
    }
  });

  it('resolves only the active exact-provider current secret and audits worker access', async () => {
    const input = createInput();
    await api.createConnection(input);
    const resolved = await worker.resolveConnectionSecret({
      workspaceId: workspaceA,
      connectionId: input.connectionId,
      expectedProviderKey: 'http',
      workerId: 'worker-connection-test',
      purpose: 'http.request.execute',
      traceId: 'trace-worker',
    });
    expect(resolved).toMatchObject({
      connection: { id: input.connectionId, status: 'active' },
      secretVersionId: input.secretVersionId,
      sealed: input.sealed,
    });
    await expect(
      worker.resolveConnectionSecret({
        workspaceId: workspaceA,
        connectionId: input.connectionId,
        expectedProviderKey: 'slack',
        workerId: 'worker-connection-test',
        purpose: 'http.request.execute',
      }),
    ).rejects.toBeInstanceOf(ConnectionUnavailableError);

    await api.revokeConnection({
      workspaceId: workspaceA,
      actorId: ownerA,
      connectionId: input.connectionId,
    });
    await expect(
      worker.resolveConnectionSecret({
        workspaceId: workspaceA,
        connectionId: input.connectionId,
        expectedProviderKey: 'http',
        workerId: 'worker-connection-test',
        purpose: 'http.request.execute',
      }),
    ).rejects.toBeInstanceOf(ConnectionUnavailableError);
  });

  it('records bounded health truth and reauthorization state through worker grants', async () => {
    const input = createInput();
    await api.createConnection(input);
    const healthy = await worker.recordConnectionHealth({
      workspaceId: workspaceA,
      connectionId: input.connectionId,
      actorKind: 'worker',
      actorId: 'worker-connection-test',
      result: { ok: true },
    });
    expect(healthy.lastHealthyAt).toBeInstanceOf(Date);
    expect(healthy.lastErrorCode).toBeNull();
    const failed = await worker.recordConnectionHealth({
      workspaceId: workspaceA,
      connectionId: input.connectionId,
      actorKind: 'worker',
      actorId: 'worker-connection-test',
      result: {
        ok: false,
        errorCode: 'connection.credential_rejected',
        reauthorizationRequired: true,
      },
    });
    expect(failed).toMatchObject({
      status: 'reauthorization_required',
      lastErrorCode: 'connection.credential_rejected',
    });
  });

  it('forces RLS, hides other workspaces, and withholds history mutation', async () => {
    const input = createInput();
    await api.createConnection(input);
    await expect(
      api.getConnection(workspaceB, input.connectionId),
    ).resolves.toBeNull();

    const apiReadinessPool = new Pool({
      connectionString: databaseUrl(apiBaseUrl),
      max: 1,
    });
    const workerReadinessPool = new Pool({
      connectionString: databaseUrl(workerBaseUrl),
      max: 1,
    });
    try {
      await expect(
        checkDatabaseReadiness(apiReadinessPool, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
        }),
      ).resolves.toMatchObject({ migrationHead: '0020_connections.sql' });
      await expect(
        checkDatabaseReadiness(workerReadinessPool, {
          ownerRole: 'pertexo_owner',
          workerRuntimeRole: 'pertexo_worker',
        }),
      ).resolves.toMatchObject({ migrationHead: '0020_connections.sql' });
    } finally {
      await Promise.all([apiReadinessPool.end(), workerReadinessPool.end()]);
    }

    const migration = new Pool({
      connectionString: databaseUrl(migrationBaseUrl),
      max: 1,
    });
    const client = await migration.connect();
    try {
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      await client.query("select set_config('app.workspace_id', $1, true)", [
        workspaceA,
      ]);
      const grants = await client.query<{
        api_secret_update: boolean;
        events_force_rls: boolean;
        events_rls: boolean;
        secrets_force_rls: boolean;
        secrets_rls: boolean;
        worker_connection_insert: boolean;
        worker_secret_select: boolean;
      }>(`
        select
          has_table_privilege('pertexo_api', 'app.connection_secret_versions', 'UPDATE') as api_secret_update,
          has_table_privilege('pertexo_worker', 'app.connections', 'INSERT') as worker_connection_insert,
          has_table_privilege('pertexo_worker', 'app.connection_secret_versions', 'SELECT') as worker_secret_select,
          secret.relrowsecurity as secrets_rls,
          secret.relforcerowsecurity as secrets_force_rls,
          event.relrowsecurity as events_rls,
          event.relforcerowsecurity as events_force_rls
        from pg_class secret, pg_class event
        where secret.oid = 'app.connection_secret_versions'::regclass
          and event.oid = 'app.connection_events'::regclass
      `);
      expect(grants.rows[0]).toEqual({
        api_secret_update: false,
        events_force_rls: true,
        events_rls: true,
        secrets_force_rls: true,
        secrets_rls: true,
        worker_connection_insert: false,
        worker_secret_select: true,
      });
      await expect(
        client.query(
          `update app.connection_secret_versions
           set ciphertext = ciphertext where id = $1`,
          [input.secretVersionId],
        ),
      ).rejects.toSatisfy(pgCode('55000'));
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
      await migration.end();
    }
  });
});
