import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { parseDatabaseConfig } from '../../../src/config.js';
import { migrateDatabase } from '../../../src/migrations.js';
import { createWorkspacePurgeCoordinator } from '../../../src/lifecycle/purge/repository.js';
import { dropDisconnectedDatabase } from '../../support/postgres/disposable-database.js';
import { emptyObjectStore } from '../../support/workspace-purge.js';
import { seedPurgeRelationships } from './seed/relations.js';
import { seedPurgeEvidence } from './seed/evidence.js';
import { seedPurgeExecution } from './seed/execution.js';

const adminBaseUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';

const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';

export const databaseName = `pertexo_test_workspace_purge_${randomUUID().replaceAll('-', '')}`;

const withDatabase = (baseUrl: string) => {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
};

export const adminUrl = withDatabase(adminBaseUrl);

const databaseUrl = withDatabase(migrationBaseUrl);

export const maintenanceUrl = withDatabase(
  process.env.DATABASE_MAINTENANCE_URL ??
    'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo',
);

export let owner: Pool | undefined;

/** Holds each object page until released. */
export class PausingObjectStore {
  public readonly started = Promise.withResolvers<undefined>();
  public readonly resume = Promise.withResolvers<undefined>();

  public async purgeWorkspacePage() {
    this.started.resolve(undefined);
    await this.resume.promise;
    return { completed: true, deletedCount: 0 };
  }
}

export async function createWorkspace(): Promise<string> {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(
      "insert into app.users(id,email,display_name) values($1,$2,'Purge owner')",
      [userId, `${userId}@example.test`],
    );
    await admin.query(
      "insert into app.workspaces(id,name,slug,created_by) values($1,'Purge fixture',$2,$3)",
      [workspaceId, `purge-${workspaceId}`, userId],
    );
  } finally {
    await admin.end();
  }
  return workspaceId;
}

export const coordinator = (objectStore = emptyObjectStore) =>
  createWorkspacePurgeCoordinator(
    parseDatabaseConfig({ connectionString: maintenanceUrl, max: 2 }),
    objectStore,
  );

export async function beforeAllFixture1() {
  const admin = new Pool({ connectionString: adminBaseUrl, max: 1 });
  try {
    await admin.query(`create database "${databaseName}" owner pertexo_owner`);
    await admin.query(`revoke all on database "${databaseName}" from public`);
    await admin.query(
      `grant connect on database "${databaseName}" to pertexo_migration,
       pertexo_maintenance,pertexo_app`,
    );
  } finally {
    await admin.end();
  }
  await migrateDatabase({
    connectionString: databaseUrl,
    ownerRole: 'pertexo_owner',
    appRole: 'pertexo_app',
    maintenanceRole: 'pertexo_maintenance',
  });
  owner = new Pool({ connectionString: databaseUrl, max: 1 });
}

export async function afterAllFixture2() {
  await owner?.end();
  const admin = new Pool({ connectionString: adminBaseUrl, max: 1 });
  try {
    await dropDisconnectedDatabase(admin, databaseName);
  } finally {
    await admin.end();
  }
}

function createPurgeSeed() {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const artifactId = randomUUID();
  const workflowId = randomUUID();
  const publishedVersionId = randomUUID();
  const historicalVersionId = randomUUID();
  const workflowRunId = randomUUID();
  const nodeRunId = randomUUID();
  const nodeAttemptId = randomUUID();
  const connectionId = randomUUID();
  const firstSecretId = randomUUID();
  const currentSecretId = randomUUID();
  const destinationId = randomUUID();
  const previewRunId = randomUUID();
  const previewAttemptId = randomUUID();
  const replacementPriorIntentId = randomUUID();
  const replacementSuccessorIntentId = randomUUID();
  const externalWorkspaceId = randomUUID();
  const externalInvitationId = randomUUID();
  const externalIntentId = randomUUID();
  const externalClaimPriorIntentId = randomUUID();
  const incomingClaimPriorIntentId = randomUUID();

  return {
    workspaceId,
    userId,
    artifactId,
    workflowId,
    publishedVersionId,
    historicalVersionId,
    workflowRunId,
    nodeRunId,
    nodeAttemptId,
    connectionId,
    firstSecretId,
    currentSecretId,
    destinationId,
    previewRunId,
    previewAttemptId,
    replacementPriorIntentId,
    replacementSuccessorIntentId,
    externalWorkspaceId,
    externalInvitationId,
    externalIntentId,
    externalClaimPriorIntentId,
    incomingClaimPriorIntentId,
  };
}

export type PurgeSeed = ReturnType<typeof createPurgeSeed>;

export async function seedPurgeScenario(owner: Pool): Promise<PurgeSeed> {
  const ids = createPurgeSeed();
  const { workspaceId } = ids;
  await owner.query('begin');
  try {
    await owner.query('set local role pertexo_owner');
    await owner.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    for (const table of [
      'workflow_runs',
      'node_runs',
      'node_attempts',
      'preview_runs',
      'preview_attempts',
      'artifact_links',
    ])
      await owner.query(`alter table app.${table} no force row level security`);
    await seedPurgeRelationships(owner, ids);
    await seedPurgeEvidence(owner, ids);
    await seedPurgeExecution(owner, ids);
    await owner.query('set constraints all immediate');
    for (const table of [
      'workflow_runs',
      'node_runs',
      'node_attempts',
      'preview_runs',
      'preview_attempts',
      'artifact_links',
    ])
      await owner.query(`alter table app.${table} force row level security`);
    await owner.query('commit');
  } catch (error: unknown) {
    await owner.query('rollback');
    throw error;
  }

  return ids;
}
