import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll } from 'vitest';

import { parseDatabaseConfig } from '../../../src/config.js';

import { createIdentityWorkspaceDatabase } from '../../../src/tenant-access/repository.js';
import { migrateDatabase } from '../../../src/migrations.js';

import type { WorkflowAuthoringDatabase } from '../../../src/authoring/workflows/repository.js';
import { createWorkflowAuthoringFixtureDatabase as createWorkflowAuthoringDatabase } from '../workflow-authoring-admission.fixture.js';

import { createDisposableDatabaseFixture } from '../postgres/disposable-database.js';
import { purgeWorkspace } from '../workspace-purge.js';
import { enforceRetention } from '../retention.js';
import { emptyGraph, currentRepresentationTag } from './drafts.js';

const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';

export const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';

const apiBaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';

const workerBaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://pertexo_app:pertexo-local-app@localhost:5432/pertexo';

const dispatcherBaseUrl =
  process.env.DATABASE_MAINTENANCE_URL ??
  'postgresql://pertexo_maintenance:pertexo-local-maintenance@localhost:5432/pertexo';

const runnerOwnsDatabase = process.env.PERTEXO_Q11_RUNNER_OWNS_DATABASE === '1';

export const databaseName = (() => {
  if (!runnerOwnsDatabase)
    return `pertexo_test_authoring_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const value = process.env.PERTEXO_Q11_DATABASE_NAME;
  if (!value || !/^pertexo_test_[a-z0-9_]+$/u.test(value) || value.length > 63)
    throw new Error('Q11 runner-owned database name is invalid');
  return value;
})();

const databaseFixture = createDisposableDatabaseFixture({
  adminUrl,
  connectRoles: ['pertexo_migration', 'pertexo_app', 'pertexo_maintenance'],
  databaseName,
  ownerRole: 'pertexo_owner',
});

export const migrationUrl = databaseFixture.databaseUrl(migrationBaseUrl);

export const apiUrl = databaseFixture.databaseUrl(apiBaseUrl);

export const workerUrl = databaseFixture.databaseUrl(workerBaseUrl);

export const dispatcherUrl = databaseFixture.databaseUrl(dispatcherBaseUrl);

export const adminDatabaseUrl = databaseFixture.databaseUrl(adminUrl);

/** Purges a workspace through the maintenance role; returns each page's step. */
export function purgeTestWorkspace(
  workspaceId: string,
  options: Pick<
    Parameters<typeof purgeWorkspace>[0],
    'afterPage' | 'objectStore' | 'pageSize'
  > = {},
): Promise<readonly string[]> {
  return purgeWorkspace({
    ...options,
    adminUrl: adminDatabaseUrl,
    maintenanceUrl: dispatcherUrl,
    workspaceId,
  });
}

/** Runs retention through the maintenance role until nothing more is due. */
export function enforceTestRetention(
  pageSize?: number,
): ReturnType<typeof enforceRetention> {
  return enforceRetention(dispatcherUrl, pageSize);
}

export const migrationConfig = {
  appRole: 'pertexo_app',
  connectionString: migrationUrl,
  maintenanceRole: 'pertexo_maintenance',
  ownerRole: 'pertexo_owner',
} as const;

export let identity: ReturnType<typeof createIdentityWorkspaceDatabase>;

export let ownerPool: Pool;

export let apiPool: Pool;

export let workerPool: Pool;

export let dispatcherPool: Pool;

export const actorId = randomUUID();

export const otherActorId = randomUUID();

export let workspaceId = '';

export let workflowId = '';

export let otherWorkspaceId = '';

export let otherWorkflowId = '';

export let otherVersionId = '';

export let authoring: WorkflowAuthoringDatabase;

const resources: {
  close(): Promise<void>;
}[] = [];

let databaseCreated = false;

function own(close: () => Promise<void>): void {
  resources.push({ close });
}

async function closeOwnedResources(): Promise<unknown[]> {
  const owned = resources.splice(0).reverse();
  const settled = await Promise.allSettled(
    owned.map((resource) => resource.close()),
  );
  return settled.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
}

async function cleanupFixture(): Promise<unknown[]> {
  const failures = await closeOwnedResources();
  if (databaseCreated) {
    databaseCreated = false;
    try {
      await databaseFixture.drop();
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  return failures;
}

beforeAll(async () => {
  try {
    if (!runnerOwnsDatabase) {
      await databaseFixture.create();
      databaseCreated = true;
    }
    await migrateDatabase(migrationConfig);
    ownerPool = new Pool({ connectionString: migrationUrl, max: 1 });
    own(() => ownerPool.end());
    apiPool = new Pool({ connectionString: apiUrl, max: 1 });
    own(() => apiPool.end());
    workerPool = new Pool({ connectionString: workerUrl, max: 1 });
    own(() => workerPool.end());
    dispatcherPool = new Pool({ connectionString: dispatcherUrl, max: 1 });
    own(() => dispatcherPool.end());
    identity = createIdentityWorkspaceDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 4 }),
    );
    own(() => identity.close());
    authoring = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 4 }),
    );
    own(() => authoring.close());
    await identity.createUser({
      id: actorId,
      email: `workflow-${actorId}@example.test`,
      displayName: 'Workflow Author',
    });
    const workspace = await identity.createWorkspaceWithOwner({
      id: randomUUID(),
      name: 'Workflow Authoring Proof',
      slug: `workflow-${actorId}`,
      ownerUserId: actorId,
      idempotencyKey: `workflow-${actorId}`,
    });
    workspaceId = workspace.id;
    const workflow = await authoring.createWorkflow({
      actorId,
      emptyGraph,
      idempotencyKey: 'create-first-workflow',
      name: 'First workflow',
      workspaceId,
    });
    workflowId = workflow.workflowId;
    await identity.createUser({
      id: otherActorId,
      email: `workflow-${otherActorId}@example.test`,
      displayName: 'Other Workflow Author',
    });
    const otherWorkspace = await identity.createWorkspaceWithOwner({
      id: randomUUID(),
      name: 'Other Workflow Workspace',
      slug: `workflow-${otherActorId}`,
      ownerUserId: otherActorId,
      idempotencyKey: `workflow-${otherActorId}`,
    });
    otherWorkspaceId = otherWorkspace.id;
    const otherWorkflow = await authoring.createWorkflow({
      actorId: otherActorId,
      emptyGraph,
      idempotencyKey: 'create-other-workflow',
      name: 'Other workflow',
      workspaceId: otherWorkspaceId,
    });
    otherWorkflowId = otherWorkflow.workflowId;
    const otherPublication = await authoring.publishWorkflow({
      actorId: otherActorId,
      representationTag: await currentRepresentationTag(
        authoring,
        otherWorkspaceId,
        { scopedWorkflowId: otherWorkflowId, scopedActorId: otherActorId },
      ),
      idempotencyKey: 'publish-other-workflow',
      requestHash: '0'.repeat(64),
      workflowId: otherWorkflowId,
      workspaceId: otherWorkspaceId,
    });
    otherVersionId = otherPublication.version.id;
  } catch (error: unknown) {
    const cleanupFailures = await cleanupFixture();
    if (cleanupFailures.length > 0)
      throw new AggregateError(
        [error, ...cleanupFailures],
        'Workflow authoring fixture setup and cleanup failed',
      );
    throw error;
  }
});

afterAll(async () => {
  const failures = await cleanupFixture();
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      'Workflow authoring fixture cleanup failed',
    );
});
