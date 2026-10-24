import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { parseDatabaseConfig } from '../../../src/config.js';
import { migrateDatabase } from '../../../src/migrations.js';
import { createEncryptionKeyRepository } from '../../../src/platform/encryption/keys.repository.js';
import { createDisposableDatabaseFixture } from '../../support/postgres/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const appUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';
const maintenanceUrl =
  process.env.DATABASE_MAINTENANCE_URL ??
  'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';
const databaseName =
  'pertexo_test_encryption_' + randomUUID().replaceAll('-', '');
const fixture = createDisposableDatabaseFixture({
  adminUrl,
  databaseName,
  ownerRole: 'pertexo_owner',
  connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_maintenance'],
});
const url = (base: string, applicationName?: string): string => {
  const value = new URL(base);
  value.pathname = '/' + databaseName;
  if (applicationName)
    value.searchParams.set('application_name', applicationName);
  return value.toString();
};
const workspaceA = randomUUID(),
  workspaceB = randomUUID(),
  actor = randomUUID(),
  connection = randomUUID(),
  firstSecret = randomUUID(),
  workflow = randomUUID(),
  version = randomUUID(),
  trigger = randomUUID();
let admin: Pool;
beforeAll(async () => {
  await fixture.create();
  await migrateDatabase({
    connectionString: url(migrationUrl),
    ownerRole: 'pertexo_owner',
    appRole: 'pertexo_app',
    maintenanceRole: 'pertexo_maintenance',
  });
  admin = new Pool({ connectionString: url(adminUrl), max: 2 });
  await admin.query(
    "insert into app.users(id,email,display_name,status) values($1,'encryption@example.test','Encryption fixture','active')",
    [actor],
  );
  for (const [id, suffix] of [
    [workspaceA, 'a'],
    [workspaceB, 'b'],
  ] as const)
    await admin.query(
      "insert into app.workspaces(id,name,slug,status,created_by) values($1,'Encryption fixture',$2,'active',$3)",
      [id, 'encryption-' + suffix, actor],
    );
  const client = await admin.connect();
  try {
    await client.query('begin');
    await client.query(
      "insert into app.connections(id,workspace_id,provider_key,name,auth_type,status,current_secret_version_id,created_by) values($1,$2,'http','Historical connection','http_headers','revoked',$3,$4)",
      [connection, workspaceA, firstSecret, actor],
    );
    await client.query(
      "insert into app.connection_secret_versions(id,workspace_id,connection_id,kms_key_reference,encrypted_data_key,ciphertext,nonce,auth_tag,created_by) select id,$2,$3,'alias/fixture','Zg','Zg',repeat('A',16),repeat('A',22),$4 from (select $1::uuid as id union all select gen_random_uuid() from generate_series(1,502)) versions",
      [firstSecret, workspaceA, connection, actor],
    );
    await client.query('commit');
  } finally {
    client.release();
  }
  await admin.query(
    "insert into app.workflows(id,workspace_id,name,lifecycle_status,created_by) values($1,$2,'Archived workflow','archived',$3)",
    [workflow, workspaceB, actor],
  );
  await admin.query(
    "insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,checksum,executable_json,published_by) values($1,$2,$3,1,'{}','wf:sha256:'||repeat('0',64),'{}',$4)",
    [version, workspaceB, workflow, actor],
  );
  await admin.query(
    "insert into app.workflow_triggers(id,workspace_id,workflow_id,workflow_version_id,node_id,kind,desired_config,config_fingerprint,status) values($1,$2,$3,$4,'webhook','webhook','{}','trigger:sha256:'||repeat('0',64),'disabled')",
    [trigger, workspaceB, workflow, version],
  );
  await admin.query(
    "insert into app.webhook_trigger_secret_versions(id,workspace_id,trigger_id,kms_key_reference,encrypted_data_key,ciphertext,nonce,auth_tag,created_by) select gen_random_uuid(),$1,$2,'alias/fixture','Zg','Zg','nonce','tag',$3 from generate_series(1,251)",
    [workspaceB, trigger, actor],
  );
}, 60000);
afterAll(async () => {
  await admin.end();
  await fixture.drop();
}, 30000);
async function inventory(base = maintenanceUrl) {
  const repository = createEncryptionKeyRepository(
    parseDatabaseConfig({ connectionString: url(base), max: 1 }),
  );
  try {
    const result = [];
    for await (const record of repository.read(AbortSignal.timeout(10000)))
      result.push(record);
    return result;
  } finally {
    await repository.close();
  }
}
describe('retained encryption key inventory', () => {
  it('reads every page and both workspaces, including revoked and archived records', async () => {
    const records = await inventory();
    expect(records.filter((row) => row.kind === 'connection')).toHaveLength(
      503,
    );
    expect(records.filter((row) => row.kind === 'webhook')).toHaveLength(251);
    expect(new Set(records.map((row) => row.workspaceId))).toEqual(
      new Set([workspaceA, workspaceB]),
    );
    expect(new Set(records.map((row) => row.secretVersionId)).size).toBe(754);
  });
  it('does not grant global inventory access to an app login', async () => {
    await expect(inventory(appUrl)).rejects.toThrow('inventory is unavailable');
    const pool = new Pool({ connectionString: url(appUrl), max: 1 });
    try {
      expect(
        (await pool.query('select id from app.connection_secret_versions'))
          .rowCount,
      ).toBe(0);
    } finally {
      await pool.end();
    }
  });
  it('keeps one snapshot while retained secrets change', async () => {
    const repository = createEncryptionKeyRepository(
      parseDatabaseConfig({ connectionString: url(maintenanceUrl), max: 1 }),
    );
    const stream = repository.read(AbortSignal.timeout(10000));
    const iterator = stream[Symbol.asyncIterator]();
    try {
      const first = await iterator.next();
      if (first.done) throw new Error('The fixture inventory is empty');
      const late = randomUUID();
      await admin.query(
        "insert into app.connection_secret_versions(id,workspace_id,connection_id,kms_key_reference,encrypted_data_key,ciphertext,nonce,auth_tag,created_by) values($1,$2,$3,'alias/fixture','Zg','Zg',repeat('A',16),repeat('A',22),$4)",
        [late, workspaceA, connection, actor],
      );
      const ids = [first.value.secretVersionId];
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        ids.push(next.value.secretVersionId);
      }
      expect(ids).toHaveLength(754);
      expect(ids).not.toContain(late);
    } finally {
      await iterator.return?.();
      await repository.close();
    }
  });
  it('returns the client after an early iterator exit', async () => {
    const repository = createEncryptionKeyRepository(
      parseDatabaseConfig({ connectionString: url(maintenanceUrl), max: 1 }),
    );
    try {
      for await (const _record of repository.read(AbortSignal.timeout(10000)))
        break;
      let count = 0;
      for await (const _record of repository.read(AbortSignal.timeout(10000)))
        count++;
      expect(count).toBe(755);
    } finally {
      await repository.close();
    }
  });
  it('cancels a blocked query and releases its transaction', async () => {
    const blocker = await admin.connect();
    const repository = createEncryptionKeyRepository(
      parseDatabaseConfig({ connectionString: url(maintenanceUrl), max: 1 }),
    );
    try {
      await blocker.query('begin');
      await blocker.query(
        'lock table app.connection_secret_versions in access exclusive mode',
      );
      const stream = repository.read(AbortSignal.timeout(100));
      const iterator = stream[Symbol.asyncIterator]();
      await expect(iterator.next()).rejects.toThrow('cancelled');
      await repository.close();
    } finally {
      await blocker.query('rollback');
      blocker.release();
      await repository.close();
    }
  });
  it('runs the release preflight against real retained metadata and sanitizes configuration failures', async () => {
    const execute = promisify(execFile);
    const script = fileURLToPath(
      new URL(
        '../../../../../infrastructure/single-server/encryption/verify.mjs',
        import.meta.url,
      ),
    );
    const environment = {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_MAINTENANCE_URL: url(maintenanceUrl),
      DATABASE_URL: url(appUrl),
      CONNECTION_ENCRYPTION_MODE: 'kms',
      CONNECTION_KMS_KEY_REFERENCE: 'alias/fixture',
      CONNECTION_KMS_REGION: 'eu-central-1',
      CONNECTION_LOCAL_KEY: undefined,
      CONNECTION_SELF_MANAGED_KEY: undefined,
      CONNECTION_SELF_MANAGED_KEY_VERSION: undefined,
      CONNECTION_SELF_MANAGED_PREVIOUS_KEYS: undefined,
    };
    const result = await execute(process.execPath, [script], {
      env: environment,
      timeout: 10000,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      event: 'encryption.verified',
      mode: 'kms',
      connectionKeys: 504,
      webhookKeys: 251,
    });
    expect(result.stderr).toBe('');
    const failure = await execute(process.execPath, [script], {
      env: {
        ...environment,
        CONNECTION_SELF_MANAGED_PREVIOUS_KEYS: 'private-configuration-fixture',
      },
      timeout: 10000,
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 1 });
    if (!(failure instanceof Error) || !('stderr' in failure))
      throw new Error('Expected the refused preflight');
    expect(String(failure.stderr)).toContain(
      'configuration_or_database_invalid',
    );
    expect(String(failure.stderr)).not.toContain(
      'private-configuration-fixture',
    );
  }, 15000);
});
