import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pool } from 'pg';
import { expect, it } from 'vitest';

import {
  migrateDatabase,
  MIGRATIONS_DIRECTORY,
} from '../../../src/migrations.js';
import { createDisposableDatabaseFixture } from '../../../src/testing/postgres/disposable-database.js';

const LOOKUP = 'select * from app.resolve_public_webhook_endpoint($1)';
const key = (letter: string) => letter.repeat(64);

type Seed = Readonly<{ admin: Pool; owner: string }>;

async function workspaceIn({ admin, owner }: Seed) {
  const id = randomUUID();
  await admin.query(
    "insert into app.workspaces(id,name,slug,created_by) values($1,'Lookup upgrade',$2,$3)",
    [id, `lookup-${id}`, owner],
  );
  return id;
}

/** An address as 0071 left it: a published step, its endpoint and its current secret. */
async function address(
  seed: Seed,
  keyHash: string,
  {
    endpointStatus = 'active',
    lifecycle = 'active',
    workspaceId,
  }: Readonly<{
    endpointStatus?: string;
    lifecycle?: string;
    workspaceId: string;
  }>,
) {
  const { admin, owner } = seed;
  const workflowId = randomUUID(),
    versionId = randomUUID(),
    triggerId = randomUUID(),
    secretId = randomUUID(),
    endpointId = randomUUID();
  await admin.query(
    "insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Lookup',$3)",
    [workflowId, workspaceId, owner],
  );
  await admin.query(
    `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,checksum,executable_json,published_by)
     values($1,$2,$3,1,'{"settings":{},"nodes":[],"edges":[]}'::jsonb,$4,'{}'::jsonb,$5)`,
    [versionId, workspaceId, workflowId, `wf:sha256:${key('a')}`, owner],
  );
  await admin.query(
    `update app.workflows set published_version_id=$2,lifecycle_status=$3 where id=$1`,
    [workflowId, versionId, lifecycle],
  );
  await admin.query(
    `insert into app.workflow_triggers(id,workspace_id,workflow_id,workflow_version_id,node_id,kind,status,desired_config,config_fingerprint)
     values($1,$2,$3,$4,'hook','webhook','active','{}'::jsonb,$5)`,
    [
      triggerId,
      workspaceId,
      workflowId,
      versionId,
      `trigger:sha256:${key('b')}`,
    ],
  );
  await admin.query(
    `insert into app.webhook_trigger_secret_versions(id,workspace_id,trigger_id,workflow_id,node_id,kms_key_reference,encrypted_data_key,ciphertext,nonce,auth_tag,created_by)
     values($1,$2,$3,$4,'hook','kms','data-key','cipher','nonce','tag',$5)`,
    [secretId, workspaceId, triggerId, workflowId, owner],
  );
  await admin.query(
    `insert into app.webhook_trigger_endpoints(id,workspace_id,workflow_id,node_id,endpoint_key_hash,status,current_secret_version_id)
     values($1,$2,$3,'hook',$4,$5,$6)`,
    [endpointId, workspaceId, workflowId, keyHash, endpointStatus, secretId],
  );
  return {
    endpointId,
    secretId,
    triggerId,
    versionId,
    workflowId,
    workspaceId,
  };
}

it('upgrades the lookup in place: open addresses answer as before, closed ones now report why', async () => {
  const adminUrl =
    process.env.DATABASE_ADMIN_URL ??
    'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
  const fixture = createDisposableDatabaseFixture({
    adminUrl,
    connectRoles: ['pertexo_app', 'pertexo_migration', 'pertexo_maintenance'],
    databaseName: `pertexo_test_lookup_upgrade_${randomUUID().replaceAll('-', '')}`,
    ownerRole: 'pertexo_owner',
  });
  const directory = await mkdtemp(join(tmpdir(), 'pertexo-lookup-upgrade-'));
  let admin: Pool | undefined;
  try {
    await fixture.create();
    for (const name of await readdir(MIGRATIONS_DIRECTORY))
      if (name.endsWith('.sql') && name < '0072')
        await copyFile(join(MIGRATIONS_DIRECTORY, name), join(directory, name));
    const config = {
      appRole: 'pertexo_app',
      ownerRole: 'pertexo_owner',
      maintenanceRole: 'pertexo_maintenance',
      connectionString: fixture.databaseUrl(
        process.env.DATABASE_MIGRATION_URL ??
          'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo',
      ),
    };
    await migrateDatabase(config, directory);
    admin = new Pool({
      connectionString: fixture.databaseUrl(adminUrl),
      max: 1,
    });
    const owner = randomUUID();
    await admin.query(
      "insert into app.users(id,email,display_name) values($1,$2,'Upgrade owner')",
      [owner, `${owner}@example.test`],
    );
    const seed = { admin, owner };
    const workspaceId = await workspaceIn(seed);
    const open = await address(seed, key('1'), { workspaceId });
    await address(seed, key('2'), { workspaceId, endpointStatus: 'disabled' });
    await address(seed, key('3'), { workspaceId, lifecycle: 'archived' });
    // Active while it's seeded: triggers refuse active integrations in anything else.
    const closingWorkspace = await workspaceIn(seed);
    await address(seed, key('4'), { workspaceId: closingWorkspace });
    await admin.query(
      "update app.workspaces set status='suspended' where id=$1",
      [closingWorkspace],
    );

    const before = await admin.query(LOOKUP, [key('1')]);
    expect(before.rows).toHaveLength(1);
    expect(before.rows[0]).not.toHaveProperty('endpoint_status');
    for (const closed of ['2', '3', '4'])
      expect((await admin.query(LOOKUP, [key(closed)])).rows).toEqual([]);
    const storedBefore = await admin.query(
      'select * from app.webhook_trigger_endpoints order by id',
    );

    await migrateDatabase(config);

    const after = await admin.query(LOOKUP, [key('1')]);
    expect(after.rows).toEqual([
      {
        ...before.rows[0],
        database_time: expect.any(Date) as unknown,
        endpoint_status: 'active',
        workflow_lifecycle_status: 'active',
        workspace_status: 'active',
      },
    ]);
    expect(after.rows[0]).toMatchObject({
      endpoint_id: open.endpointId,
      current_secret_version_id: open.secretId,
      workflow_version_id: open.versionId,
    });
    expect((await admin.query(LOOKUP, [key('2')])).rows).toMatchObject([
      { endpoint_status: 'disabled' },
    ]);
    expect((await admin.query(LOOKUP, [key('3')])).rows).toMatchObject([
      { workflow_lifecycle_status: 'archived' },
    ]);
    expect((await admin.query(LOOKUP, [key('4')])).rows).toMatchObject([
      { workspace_status: 'suspended' },
    ]);
    expect((await admin.query(LOOKUP, [key('9')])).rows).toEqual([]);
    // The upgrade changes the door, not what's behind it.
    expect(
      (
        await admin.query(
          'select * from app.webhook_trigger_endpoints order by id',
        )
      ).rows,
    ).toEqual(storedBefore.rows);
    const signature = 'app.resolve_public_webhook_endpoint(character)';
    const { rows: grants } = await admin.query<{
      app: boolean;
      maintenance: boolean;
    }>(
      `select has_function_privilege('pertexo_app',$1,'execute') app,
              has_function_privilege('pertexo_maintenance',$1,'execute') maintenance`,
      [signature],
    );
    expect(grants).toEqual([{ app: true, maintenance: false }]);
  } finally {
    await admin?.end();
    await fixture.drop();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
