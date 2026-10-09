import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import {
  verifyCuratedFixtureOwnership,
  recheckCuratedFixtureOwnership,
} from '../../../../infrastructure/testing/curated-template-owned-fixture.mjs';
import { parseDatabaseConfig } from '../../src/config.js';
import { migrateDatabase } from '../../src/migrations.js';
import { createIdentityWorkspaceDatabase } from '../../src/tenant-access/database.js';
import { createArtifactMigrationConfig } from './artifact-migration-fixture.js';
import { createDisposableDatabaseFixture } from './disposable-database.js';
import { createWorkflowAuthoringFixtureDatabase } from './workflow-authoring-admission.fixture.js';
import { createWorkflowTagDatabase } from '../../src/authoring/organization/tags.repository.js';
import {
  createWorkflowFolderDatabase,
  createWorkflowOrganizationBatchDatabase,
} from '../../src/authoring/index.js';
import { createWorkflowOrganizationReadDatabase } from '../../src/authoring/organization/workflows.queries.js';
import { createWorkflowFavoriteDatabase } from '../../src/authoring/organization/favorites.repository.js';

const roles = {
  DATABASE_ADMIN_URL: 'postgres',
  DATABASE_MIGRATION_URL: 'pertexo_migration',
  DATABASE_URL: 'pertexo_app',
  DATABASE_MAINTENANCE_URL: 'pertexo_maintenance',
} as const;

export const organizationFixtureEnabled =
  process.env.F07_ORGANIZATION_OWNED_FIXTURE === 'true';
export const commandKey = () =>
  createHash('sha256').update(randomUUID()).digest('hex');

async function ownership() {
  const canonical = await verifyCuratedFixtureOwnership();
  const urls = {} as Record<keyof typeof roles, string>;
  const reference = new URL(process.env.DATABASE_ADMIN_URL ?? '');
  for (const [name, role] of Object.entries(roles)) {
    const raw = process.env[name];
    if (raw === undefined) throw new Error(`Explicit ${name} is required`);
    const url = new URL(raw);
    if (
      url.protocol !== 'postgresql:' ||
      url.username !== role ||
      url.password.length === 0 ||
      url.hostname !== reference.hostname ||
      url.port !== reference.port ||
      url.search !== '' ||
      url.hash !== '' ||
      (name === 'DATABASE_ADMIN_URL' && url.pathname !== '/postgres')
    )
      throw new Error(`F07 owned role URL is invalid: ${name}`);
    urls[name as keyof typeof roles] = raw;
  }
  return {
    canonical,
    manifest: process.env.EDITOR_BROWSER_OWNERSHIP_MANIFEST,
    redis: process.env.REDIS_URL,
    urls,
  };
}

export async function createOrganizationOwnedFixture() {
  if (!organizationFixtureEnabled)
    throw new Error('Explicit F07 owned fixture flag is required');
  const attestation = await ownership();
  const databaseName = `pertexo_test_f07_organization_${randomBytes(12).toString('hex')}`;
  const disposable = createDisposableDatabaseFixture({
    adminUrl: attestation.urls.DATABASE_ADMIN_URL,
    connectRoles: Object.values(roles).filter((role) => role !== 'postgres'),
    databaseName,
    ownerRole: 'pertexo_owner',
  });
  const resources: { close(): Promise<void> }[] = [];
  let created = false;
  async function recheck() {
    await recheckCuratedFixtureOwnership(attestation.canonical);
    if (JSON.stringify(await ownership()) !== JSON.stringify(attestation))
      throw new Error('F07 ownership changed after acquisition');
  }
  async function close() {
    const failures: unknown[] = [];
    for (const resource of resources.splice(0).reverse()) {
      try {
        await resource.close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (created && failures.length === 0) {
      try {
        await recheck();
        await disposable.drop();
        created = false;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, 'F07 owned fixture cleanup failed');
  }
  try {
    await recheck();
    await disposable.create();
    created = true;
    const migrationUrl = disposable.databaseUrl(
      attestation.urls.DATABASE_MIGRATION_URL,
    );
    const migrationConfig = createArtifactMigrationConfig(migrationUrl);
    await migrateDatabase(migrationConfig);
    async function upgrade() {
      await recheck();
      return migrateDatabase(migrationConfig);
    }
    function pool(base: string) {
      const value = new Pool({
        connectionString: disposable.databaseUrl(base),
        max: 4,
        connectionTimeoutMillis: 3000,
      });
      resources.push({ close: () => value.end() });
      return value;
    }
    const owner = pool(attestation.urls.DATABASE_ADMIN_URL);
    const api = pool(attestation.urls.DATABASE_URL);
    const worker = pool(attestation.urls.DATABASE_URL);
    const dispatcher = pool(attestation.urls.DATABASE_MAINTENANCE_URL);
    const maintenance = pool(attestation.urls.DATABASE_MAINTENANCE_URL);
    const config = parseDatabaseConfig({
      connectionString: disposable.databaseUrl(attestation.urls.DATABASE_URL),
      max: 4,
    });
    const identity = createIdentityWorkspaceDatabase(config);
    const authoring = createWorkflowAuthoringFixtureDatabase(config);
    const tags = createWorkflowTagDatabase(config);
    const favorites = createWorkflowFavoriteDatabase(config);
    resources.push(identity, authoring, tags, favorites);
    function folderStores() {
      const folders = createWorkflowFolderDatabase(config);
      const batches = createWorkflowOrganizationBatchDatabase(config);
      resources.push(folders, batches);
      return { folders, batches };
    }
    function organizationStores() {
      const reader = createWorkflowOrganizationReadDatabase(config);
      const favorites = createWorkflowFavoriteDatabase(config);
      resources.push(reader, favorites);
      return { reader, favorites };
    }

    async function transaction<T>(
      selected: Pool,
      workspace: string,
      actor: string,
      work: (client: PoolClient) => Promise<T>,
    ) {
      const client = await selected.connect();
      try {
        await client.query('begin');
        await client.query("set local statement_timeout='8s'");
        await client.query(
          "select set_config('app.workspace_id',$1,true),set_config('app.actor_id',$2,true)",
          [workspace, actor],
        );
        if (selected === owner)
          await client.query('set local role pertexo_owner');
        const result = await work(client);
        await client.query('commit');
        return result;
      } finally {
        try {
          await client.query('rollback');
        } finally {
          client.release();
        }
      }
    }
    async function scope() {
      const actor = randomUUID(),
        viewer = randomUUID(),
        builder = randomUUID();
      for (const id of [actor, viewer, builder])
        await identity.createUser({
          id,
          email: `${id}@example.test`,
          displayName: 'Owned F07 SQL fixture',
        });
      const workspace = (
        await identity.createWorkspaceWithOwner({
          id: randomUUID(),
          name: 'F07 owned SQL fixture',
          slug: `f07-${actor}`,
          ownerUserId: actor,
          idempotencyKey: randomUUID(),
        })
      ).id;
      await transaction(owner, workspace, actor, (client) =>
        client.query(
          `insert into app.workspace_memberships(workspace_id,user_id,role,status)
           values($1,$2,'viewer','active'),($1,$3,'builder','active')`,
          [workspace, viewer, builder],
        ),
      );
      async function workflow(name = 'F07 ordinary workflow') {
        return (
          await authoring.createWorkflow({
            workspaceId: workspace,
            actorId: actor,
            name,
            emptyGraph: {
              schemaVersion: 1,
              nodes: [],
              edges: [],
              settings: {},
            },
            idempotencyKey: randomUUID(),
          })
        ).workflowId;
      }
      return { actor, viewer, builder, workspace, workflow };
    }
    async function waitForBlocker(blocker: number, waiter: number) {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const rows = await owner.query<{ blocked: boolean }>(
          'select $1::int=any(pg_blocking_pids($2::int)) blocked',
          [blocker, waiter],
        );
        if (rows.rows[0]?.blocked) return;
        // Poll observed database state, never use elapsed time as race evidence.
        await owner.query('select pg_sleep(0.01)');
      }
      throw new Error('F07 expected PostgreSQL blocker was not observed');
    }
    return {
      urls: {
        admin: disposable.databaseUrl(attestation.urls.DATABASE_ADMIN_URL),
        maintenance: disposable.databaseUrl(
          attestation.urls.DATABASE_MAINTENANCE_URL,
        ),
      },
      owner,
      api,
      worker,
      dispatcher,
      maintenance,
      identity,
      authoring,
      tags,
      favorites,
      folderStores,
      organizationStores,
      upgrade,
      transaction,
      scope,
      waitForBlocker,
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'F07 setup and cleanup failed',
      );
    }
    throw error;
  }
}

export type OrganizationOwnedFixture = Awaited<
  ReturnType<typeof createOrganizationOwnedFixture>
>;
