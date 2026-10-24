import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';

import { parseDatabaseConfig } from '../../../src/config.js';
import { createArtifactUploadDatabase } from '../../../src/artifacts/uploads/repository.js';
import { migrateDatabase } from '../../../src/migrations.js';
import { createDisposableDatabaseFixture } from '../../support/postgres/disposable-database.js';

const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';

const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';

const apiBaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';

const databaseName = `pertexo_test_artifact_upload_${randomUUID().replaceAll('-', '')}`;

const fixture = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_maintenance'],
  databaseName,
  ownerRole: 'pertexo_owner',
});

const migrationUrl = fixture.databaseUrl(migrationBaseUrl);

const apiUrl = fixture.databaseUrl(apiBaseUrl);

const migrationConfig = {
  appRole: 'pertexo_app',
  connectionString: migrationUrl,
  maintenanceRole: 'pertexo_maintenance',
  ownerRole: 'pertexo_owner',
} as const;

export let database!: ReturnType<typeof createArtifactUploadDatabase>;

let apiProbePool!: Pool;

let ownerPool!: Pool;

let databaseCreated = false;

let databaseAcquired = false;

let apiProbePoolAcquired = false;

let ownerPoolAcquired = false;

export let workspaceId = randomUUID();

export let actorId = randomUUID();

let sessionId = randomUUID();

export const actor = () => ({
  actorId,
  kind: 'user' as const,
  requestId: 'artifact-upload-integration',
  sessionId,
  workspaceId,
});

export async function ownerTransactionAt<T>(
  scopedWorkspaceId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      scopedWorkspaceId,
    ]);
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function ownerTransaction<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return ownerTransactionAt(workspaceId, work);
}

export async function apiTransaction<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await apiProbePool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.workspace_id',$1,true)", [
      workspaceId,
    ]);
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function setCapacity(
  byteLimit: number,
  artifactCountLimit: number,
): Promise<void> {
  await ownerTransaction(async (client) => {
    await client.query(
      `insert into app.workspace_artifact_capacity
         (workspace_id,byte_limit,artifact_count_limit,charged_bytes,charged_count)
       values ($1,$2,$3,0,0)
       on conflict (workspace_id) do update set
         byte_limit=excluded.byte_limit,
         artifact_count_limit=excluded.artifact_count_limit,
         updated_at=clock_timestamp()`,
      [workspaceId, byteLimit, artifactCountLimit],
    );
  });
}

export async function readCapacity(): Promise<{
  chargedBytes: number;
  chargedCount: number;
}> {
  return ownerTransaction(async (client) => {
    const result = await client.query<{
      charged_bytes: number | string;
      charged_count: number;
    }>(
      `select charged_bytes,charged_count
         from app.workspace_artifact_capacity where workspace_id=$1`,
      [workspaceId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('artifact capacity row missing');
    return {
      chargedBytes: Number(row.charged_bytes),
      chargedCount: row.charged_count,
    };
  });
}

async function cleanupFixture(): Promise<void> {
  await ownerTransaction(async (client) => {
    await client.query(
      `update app.artifacts set status='deleting',updated_at=clock_timestamp()
         where workspace_id=$1 and status in ('pending','available')`,
      [workspaceId],
    );
    await client.query(
      `update app.artifacts
          set status='deleted',deleted_at=clock_timestamp(),updated_at=clock_timestamp()
        where workspace_id=$1 and status='deleting'`,
      [workspaceId],
    );
    await client.query('delete from app.artifacts where workspace_id=$1', [
      workspaceId,
    ]);
    await client.query(
      'delete from app.idempotency_records where workspace_id=$1',
      [workspaceId],
    );
    await client.query(
      'delete from app.workspace_artifact_capacity where workspace_id=$1',
      [workspaceId],
    );
  });
}

export async function beforeAllFixture1() {
  try {
    await fixture.create();
    databaseCreated = true;
    await migrateDatabase(migrationConfig);
    database = createArtifactUploadDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 4 }),
    );
    databaseAcquired = true;
    apiProbePool = new Pool({ connectionString: apiUrl, max: 1 });
    apiProbePoolAcquired = true;
    ownerPool = new Pool({ connectionString: migrationUrl, max: 2 });
    ownerPoolAcquired = true;
  } catch (error: unknown) {
    const cleanup = await Promise.allSettled([
      ...(databaseAcquired ? [database.close()] : []),
      ...(apiProbePoolAcquired ? [apiProbePool.end()] : []),
      ...(ownerPoolAcquired ? [ownerPool.end()] : []),
      ...(databaseCreated ? [fixture.drop()] : []),
    ]);
    const failures: unknown[] = [error];
    for (const result of cleanup)
      if (result.status === 'rejected') failures.push(result.reason);
    throw new AggregateError(failures, 'Artifact upload fixture setup failed');
  }
}

export async function beforeEachFixture2() {
  workspaceId = randomUUID();
  actorId = randomUUID();
  sessionId = randomUUID();
  await ownerTransaction(async (client) => {
    await client.query(
      `insert into app.users(id,email,display_name,status)
       values($1,$2,'Artifact upload actor','active')`,
      [actorId, `${actorId}@artifact-upload.integration.test`],
    );
    await client.query(
      `insert into app.workspaces(id,name,slug,status,created_by)
       values($1,'Artifact upload workspace',$2,'active',$3)`,
      [workspaceId, `artifact-upload-${workspaceId.slice(0, 12)}`, actorId],
    );
    await client.query(
      `insert into app.workspace_memberships(workspace_id,user_id,role,status)
       values($1,$2,'owner','active')`,
      [workspaceId, actorId],
    );
  });
  await setCapacity(1_000, 100);
}

export async function afterEachFixture3() {
  await cleanupFixture();
}

export async function afterAllFixture4() {
  const failures: unknown[] = [];
  const closed = await Promise.allSettled([
    ...(databaseAcquired ? [database.close()] : []),
    ...(apiProbePoolAcquired ? [apiProbePool.end()] : []),
    ...(ownerPoolAcquired ? [ownerPool.end()] : []),
  ]);
  for (const result of closed)
    if (result.status === 'rejected') failures.push(result.reason);
  if (databaseCreated) {
    try {
      await fixture.drop();
      databaseCreated = false;
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      'Artifact upload fixture cleanup failed',
    );
}
