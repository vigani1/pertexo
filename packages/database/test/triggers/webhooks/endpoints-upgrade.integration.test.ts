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
import { createDisposableDatabaseFixture } from '../../support/postgres/disposable-database.js';

const liveKey = 'a'.repeat(64);
const replacedKey = 'b'.repeat(64);
const killedKey = 'c'.repeat(64);
const removedKey = 'd'.repeat(64);

type Seed = Readonly<{ admin: Pool; workspaceId: string; owner: string }>;

async function workflowWithVersions(
  { admin, workspaceId, owner }: Seed,
  count: number,
) {
  const workflowId = randomUUID();
  await admin.query(
    "insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Upgrade workflow',$3)",
    [workflowId, workspaceId, owner],
  );
  const versions: string[] = [];
  for (let number = 1; number <= count; number += 1) {
    const id = randomUUID();
    await admin.query(
      "insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,checksum,executable_json,published_by) values($1,$2,$3,$4,'{}','wf:sha256:'||repeat('0',64),'{}',$5)",
      [id, workspaceId, workflowId, number, owner],
    );
    versions.push(id);
  }
  await admin.query(
    "update app.workflows set published_version_id=$1,activation_status='degraded' where id=$2",
    [versions.at(-1), workflowId],
  );
  return { workflowId, versions };
}

async function webhookTrigger(
  { admin, workspaceId }: Seed,
  scope: Readonly<{ workflowId: string; versionId: string; status: string }>,
) {
  const triggerId = randomUUID();
  await admin.query(
    "insert into app.workflow_triggers(id,workspace_id,workflow_id,workflow_version_id,node_id,kind,desired_config,config_fingerprint,status) values($1,$2,$3,$4,'webhook','webhook','{}','trigger:sha256:'||repeat('0',64),$5)",
    [triggerId, workspaceId, scope.workflowId, scope.versionId, scope.status],
  );
  return triggerId;
}

/** A row as the old schema wrote it: one endpoint and one secret per version's trigger. */
async function legacyEndpoint(
  { admin, workspaceId, owner }: Seed,
  scope: Readonly<{ triggerId: string; keyHash: string; status: string }>,
) {
  const secretId = randomUUID(),
    endpointId = randomUUID();
  await admin.query(
    "insert into app.webhook_trigger_secret_versions(id,workspace_id,trigger_id,kms_key_reference,encrypted_data_key,ciphertext,nonce,auth_tag,created_by) values($1,$2,$3,'alias/fixture','Zg','Zg','nonce','tag',$4)",
    [secretId, workspaceId, scope.triggerId, owner],
  );
  await admin.query(
    'insert into app.webhook_trigger_endpoints(id,workspace_id,trigger_id,endpoint_key_hash,status,current_secret_version_id) values($1,$2,$3,$4,$5,$6)',
    [
      endpointId,
      workspaceId,
      scope.triggerId,
      scope.keyHash,
      scope.status,
      secretId,
    ],
  );
  return { secretId, endpointId };
}

async function rejectedDelivery(
  { admin, workspaceId }: Seed,
  scope: Readonly<{ triggerId: string; endpointId: string }>,
) {
  const id = randomUUID();
  await admin.query(
    "insert into app.webhook_trigger_deliveries(id,workspace_id,trigger_id,endpoint_id,outcome,http_status,signature_check,replay_check,body_bytes) values($1,$2,$3,$4,'authentication_failed',401,'mismatch','not_checked',2)",
    [id, workspaceId, scope.triggerId, scope.endpointId],
  );
  return id;
}

async function olderDatabase(
  work: (context: Seed & { upgrade: () => Promise<unknown> }) => Promise<void>,
) {
  const adminUrl =
    process.env.DATABASE_ADMIN_URL ??
    'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
  const fixture = createDisposableDatabaseFixture({
    adminUrl,
    connectRoles: ['pertexo_app', 'pertexo_migration', 'pertexo_maintenance'],
    databaseName: `pertexo_test_endpoints_upgrade_${randomUUID().replaceAll('-', '')}`,
    ownerRole: 'pertexo_owner',
  });
  const directory = await mkdtemp(join(tmpdir(), 'pertexo-endpoints-upgrade-'));
  let admin: Pool | undefined;
  try {
    await fixture.create();
    for (const name of await readdir(MIGRATIONS_DIRECTORY))
      if (name.endsWith('.sql') && name < '0060')
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
    const owner = randomUUID(),
      workspaceId = randomUUID();
    await admin.query(
      "insert into app.users(id,email,display_name) values($1,$2,'Upgrade owner')",
      [owner, `${owner}@example.test`],
    );
    await admin.query(
      "insert into app.workspaces(id,name,slug,created_by) values($1,'Endpoint upgrade',$2,$3)",
      [workspaceId, `endpoints-${workspaceId}`, owner],
    );
    await work({
      admin,
      workspaceId,
      owner,
      upgrade: () => migrateDatabase(config),
    });
  } finally {
    await admin?.end();
    await fixture.drop();
    await rm(directory, { recursive: true, force: true });
  }
}

async function resolved(admin: Pool, keyHash: string) {
  return (
    await admin.query<{
      endpoint_id: string;
      workflow_version_id: string;
      current_secret_version_id: string;
      current_secret_trigger_id: string;
    }>('select * from app.resolve_public_webhook_endpoint($1)', [keyHash])
  ).rows;
}

it('keeps a live endpoint answering after the upgrade, and folds in the rows earlier publishes retired', async () => {
  await olderDatabase(async (context) => {
    const { admin, upgrade } = context;
    const { workflowId, versions } = await workflowWithVersions(context, 2);
    const [v1, v2] = versions as [string, string];
    const oldTrigger = await webhookTrigger(context, {
      workflowId,
      versionId: v1,
      status: 'disabled',
    });
    const liveTrigger = await webhookTrigger(context, {
      workflowId,
      versionId: v2,
      status: 'active',
    });
    const replaced = await legacyEndpoint(context, {
      triggerId: oldTrigger,
      keyHash: replacedKey,
      status: 'disabled',
    });
    const live = await legacyEndpoint(context, {
      triggerId: liveTrigger,
      keyHash: liveKey,
      status: 'active',
    });
    const before = await rejectedDelivery(context, {
      triggerId: oldTrigger,
      endpointId: replaced.endpointId,
    });
    const after = await rejectedDelivery(context, {
      triggerId: liveTrigger,
      endpointId: live.endpointId,
    });

    await upgrade();

    expect(await resolved(admin, liveKey)).toMatchObject([
      {
        endpoint_id: live.endpointId,
        workflow_version_id: v2,
        current_secret_version_id: live.secretId,
        current_secret_trigger_id: liveTrigger,
      },
    ]);
    expect(await resolved(admin, replacedKey)).toEqual([]);
    expect(
      (
        await admin.query(
          'select id,node_id,status from app.webhook_trigger_endpoints where workflow_id=$1',
          [workflowId],
        )
      ).rows,
    ).toEqual([{ id: live.endpointId, node_id: 'webhook', status: 'active' }]);
    expect(
      (
        await admin.query(
          'select id,endpoint_id from app.webhook_trigger_deliveries order by id',
        )
      ).rows,
    ).toEqual(
      [before, after]
        .sort()
        .map((id) => ({ id, endpoint_id: live.endpointId })),
    );
    expect(
      (
        await admin.query(
          'select id from app.webhook_trigger_secret_versions where workflow_id=$1',
          [workflowId],
        )
      ).rows,
    ).toEqual([{ id: live.secretId }]);
  });
}, 120_000);

it('brings back an address a publish killed, under the secret’s original sealing', async () => {
  await olderDatabase(async (context) => {
    const { admin, upgrade } = context;
    const { workflowId, versions } = await workflowWithVersions(context, 2);
    const [v1, v2] = versions as [string, string];
    const oldTrigger = await webhookTrigger(context, {
      workflowId,
      versionId: v1,
      status: 'disabled',
    });
    await webhookTrigger(context, {
      workflowId,
      versionId: v2,
      status: 'configuration_required',
    });
    const killed = await legacyEndpoint(context, {
      triggerId: oldTrigger,
      keyHash: killedKey,
      status: 'disabled',
    });

    await upgrade();

    expect(await resolved(admin, killedKey)).toMatchObject([
      {
        endpoint_id: killed.endpointId,
        workflow_version_id: v2,
        current_secret_version_id: killed.secretId,
        current_secret_trigger_id: oldTrigger,
      },
    ]);
    expect(
      (
        await admin.query(
          `select trigger.status,trigger.health_status,workflow.activation_status
             from app.workflow_triggers trigger
             join app.workflows workflow on workflow.id=trigger.workflow_id
            where trigger.workflow_version_id=$1`,
          [v2],
        )
      ).rows,
    ).toEqual([
      {
        status: 'active',
        health_status: 'healthy',
        activation_status: 'active',
      },
    ]);
  });
}, 120_000);

it('leaves an address retired when the published version no longer has its step', async () => {
  await olderDatabase(async (context) => {
    const { admin, upgrade } = context;
    const { workflowId, versions } = await workflowWithVersions(context, 2);
    const [v1] = versions as [string, string];
    const oldTrigger = await webhookTrigger(context, {
      workflowId,
      versionId: v1,
      status: 'disabled',
    });
    const removed = await legacyEndpoint(context, {
      triggerId: oldTrigger,
      keyHash: removedKey,
      status: 'disabled',
    });

    await upgrade();

    expect(await resolved(admin, removedKey)).toEqual([]);
    expect(
      (
        await admin.query(
          'select id,status from app.webhook_trigger_endpoints where workflow_id=$1',
          [workflowId],
        )
      ).rows,
    ).toEqual([{ id: removed.endpointId, status: 'disabled' }]);
  });
}, 120_000);
