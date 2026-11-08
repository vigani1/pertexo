import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createDisposableDatabaseFixture,
  migrateDatabase,
  parseDatabaseConfig,
} from '@pertexo/database/testing';
import { createConnectionEnvelopeEncryption } from '../../src/encryption/connection-encryption.runtime.js';
import { createEncryptionKeyRepository } from '../../src/encryption/keys.repository.js';
import { verifyStoredEncryptionKeys } from '../../src/encryption/verify-stored-keys.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const maintenanceUrl =
  process.env.DATABASE_MAINTENANCE_URL ??
  'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';
const appUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';
const databaseName = `pertexo_test_form_keys_${randomUUID().replaceAll('-', '')}`;
const fixture = createDisposableDatabaseFixture({
  adminUrl,
  databaseName,
  ownerRole: 'pertexo_owner',
  connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_maintenance'],
});
const url = (base: string) => {
  const value = new URL(base);
  value.pathname = `/${databaseName}`;
  return value.toString();
};
const oldKey = { version: 'old', key: Buffer.alloc(32, 21).toString('base64') };
const newKey = { version: 'new', key: Buffer.alloc(32, 22).toString('base64') };
const config = (previous: readonly (typeof oldKey)[] = []) => ({
  mode: 'self-managed' as const,
  encryption: { current: newKey, previous },
});
const oldRuntime = createConnectionEnvelopeEncryption({
  mode: 'self-managed',
  encryption: { current: oldKey, previous: [] },
});
const workspaceId = randomUUID(),
  actorId = randomUUID(),
  workflowId = randomUUID();
const capability = 'a'.repeat(43);
let admin: Pool;

beforeAll(async () => {
  await fixture.create();
  await migrateDatabase({
    connectionString: url(migrationUrl),
    ownerRole: 'pertexo_owner',
    appRole: 'pertexo_app',
    maintenanceRole: 'pertexo_maintenance',
  });
  admin = new Pool({ connectionString: url(adminUrl), max: 1 });
  await admin.query(
    "insert into app.users(id,email,display_name) values($1,$2,'Form key fixture')",
    [actorId, `${actorId}@example.test`],
  );
  await admin.query(
    "insert into app.workspaces(id,name,slug,created_by) values($1,'Form keys',$2,$3)",
    [workspaceId, workspaceId, actorId],
  );
  await storeForm(workflowId);
}, 60_000);
afterAll(async () => {
  oldRuntime.close();
  await admin.end();
  await fixture.drop();
}, 30_000);

async function storeForm(id: string) {
  const sealed = await oldRuntime.encryption.seal(Buffer.from(capability), {
    workspaceId,
    connectionId: id,
    secretVersionId: id,
  });
  await admin.query(
    "insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Retained form',$3)",
    [id, workspaceId, actorId],
  );
  await admin.query(
    "insert into app.workflow_forms(workspace_id,workflow_id,node_id,public_id,access,capability_hash,sealed_capability) values($1,$2,'form',$3,'public',$4,$5)",
    [
      workspaceId,
      id,
      randomUUID(),
      createHash('sha256').update(capability).digest('hex'),
      JSON.stringify(sealed),
    ],
  );
}
async function verify(settings = config([oldKey])) {
  const repository = createEncryptionKeyRepository(
    parseDatabaseConfig({ connectionString: url(maintenanceUrl), max: 1 }),
  );
  try {
    const signal = AbortSignal.timeout(10_000);
    return await verifyStoredEncryptionKeys(
      settings,
      repository.read(signal),
      signal,
    );
  } finally {
    await repository.close();
  }
}

it.each([
  ['missing', []],
  ['wrong', [{ ...oldKey, key: Buffer.alloc(32, 23).toString('base64') }]],
] as const)(
  'refuses a %s key used only by a saved form link',
  async (_name, previous) => {
    await expect(verify(config(previous))).rejects.toMatchObject({
      code: 'unavailable_key_material',
    });
  },
);
it('verifies a form-only historical key with its original workflow context', async () => {
  await expect(verify()).resolves.toEqual({
    connectionKeys: 1,
    webhookKeys: 0,
  });
});
it('refuses switching providers when only a form needs the old provider', async () => {
  const repository = createEncryptionKeyRepository(
    parseDatabaseConfig({ connectionString: url(maintenanceUrl), max: 1 }),
  );
  try {
    const signal = AbortSignal.timeout(10_000);
    await expect(
      verifyStoredEncryptionKeys(
        { keyReference: 'alias/fixture', region: 'us-east-1' },
        repository.read(signal),
        signal,
      ),
    ).rejects.toMatchObject({ code: 'incompatible_provider' });
  } finally {
    await repository.close();
  }
});
it('returns only the wrapped form key and skips hash-only legacy links', async () => {
  const legacyId = randomUUID();
  await storeForm(legacyId);
  await admin.query(
    'update app.workflow_forms set sealed_capability=null where workflow_id=$1',
    [legacyId],
  );
  const repository = createEncryptionKeyRepository(
    parseDatabaseConfig({ connectionString: url(maintenanceUrl), max: 1 }),
  );
  try {
    const records = [];
    for await (const record of repository.read(AbortSignal.timeout(10_000)))
      records.push(record);
    expect(records).toEqual([
      {
        kind: 'connection',
        workspaceId,
        resourceId: workflowId,
        secretVersionId: workflowId,
        keyReference: 'self-managed',
        encryptedDataKey: expect.any(String) as unknown,
      },
    ]);
    expect(JSON.stringify(records)).not.toContain(capability);
    expect(JSON.stringify(records)).not.toContain('ciphertext');
  } finally {
    await repository.close();
  }
});
it.each([
  ['missing', []],
  ['wrong', [{ ...oldKey, key: Buffer.alloc(32, 23).toString('base64') }]],
] as const)(
  'refuses deploy/restore preflight with a %s form-only key',
  async (_name, previous) => {
    const execute = promisify(execFile);
    const script = fileURLToPath(
      new URL(
        '../../../../infrastructure/single-server/encryption/verify.mjs',
        import.meta.url,
      ),
    );
    await expect(
      execute(process.execPath, [script], {
        env: {
          ...process.env,
          NODE_ENV: 'test',
          DATABASE_MAINTENANCE_URL: url(maintenanceUrl),
          DATABASE_URL: url(appUrl),
          CONNECTION_ENCRYPTION_MODE: 'self-managed',
          CONNECTION_SELF_MANAGED_KEY: newKey.key,
          CONNECTION_SELF_MANAGED_KEY_VERSION: newKey.version,
          CONNECTION_SELF_MANAGED_PREVIOUS_KEYS: JSON.stringify(previous),
          CONNECTION_LOCAL_KEY: undefined,
          CONNECTION_KMS_KEY_REFERENCE: undefined,
          CONNECTION_KMS_REGION: undefined,
          CONNECTION_KMS_ENDPOINT: undefined,
        },
        timeout: 20_000,
      }),
    ).rejects.toMatchObject({
      code: 1,
      stdout: '',
      stderr: expect.stringContaining(
        '"code":"unavailable_key_material"',
      ) as unknown,
    });
  },
  25_000,
);
it('checks every page of retained form envelopes', async () => {
  for (let index = 0; index < 250; index++) await storeForm(randomUUID());
  await expect(verify()).resolves.toEqual({
    connectionKeys: 251,
    webhookKeys: 0,
  });
}, 30_000);
