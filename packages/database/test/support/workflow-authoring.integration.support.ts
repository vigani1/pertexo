import { createHash, randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll } from 'vitest';
import {
  EMPTY_DEFINITION_CATALOG,
  workflowCompatibilityReport,
  type WorkflowDefinitionCatalog,
  workflowDraftRepresentationTag,
} from '@pertexo/workflow-model/server';

import { parseDatabaseConfig } from '../../src/config.js';
import {
  CONNECTION_AUTH_TYPE,
  createConnectionDatabase,
} from '../../src/connections/connections.js';
import { createIdentityWorkspaceDatabase } from '../../src/tenant-access/identity-workspace.js';
import { migrateDatabase } from '../../src/migrations.js';
import { IdempotencyConflictError } from '../../src/platform/idempotency.js';
import { checkDatabaseReadiness } from '../../src/platform/readiness.js';
import {
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
  type WorkflowAuthoringDatabase,
} from '../../src/authoring/workflows/database.js';
import { createWorkflowAuthoringFixtureDatabase as createWorkflowAuthoringDatabase } from './workflow-authoring-admission.fixture.js';
import { createWorkflowIntegrationUsageDatabase } from '../../src/connections/workflow-integration-usage.js';
import { createDisposableDatabaseFixture } from './disposable-database.js';
import { purgeWorkspace } from './workspace-purge.js';
import { enforceRetention } from './retention.js';

const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const adminUrl =
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
const databaseName = (() => {
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
const adminDatabaseUrl = databaseFixture.databaseUrl(adminUrl);

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
export const emptyGraph = {
  edges: [],
  nodes: [],
  schemaVersion: 1,
  settings: {},
};
export const draftNode = (
  id: string,
  config: Record<string, unknown> = {},
) => ({
  id,
  definition: { key: 'test.placeholder', version: 1 },
  position: { x: 0, y: 0 },
  configVersion: 1,
  config,
  inputMappings: {},
  connectionRefs: {},
});
export const testDefinitionCatalog = Object.freeze({
  schemaVersion: 1 as const,
  definitions: Object.freeze([
    Object.freeze({ key: 'test.placeholder', version: 1 }),
  ]),
});
export const baselineEmptyDefinitionCatalog = Object.freeze({
  schemaVersion: 1 as const,
  definitions: Object.freeze([]),
});
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

export function deferred(): Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}> {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

export async function waitForOperationEntry(
  entry: Promise<void>,
  operation: Promise<unknown>,
  label: string,
): Promise<void> {
  await Promise.race([
    entry,
    operation.then(
      () => {
        throw new Error(`${label} settled before its test hook`);
      },
      (error: unknown) => {
        throw error;
      },
    ),
  ]);
}

export async function finishControlledScenario(
  input: Readonly<{
    close: readonly (() => Promise<void>)[];
    label: string;
    operations: readonly (Promise<unknown> | undefined)[];
    primaryError: unknown;
    release: () => void;
  }>,
): Promise<void> {
  input.release();
  await Promise.allSettled(
    input.operations.filter(
      (operation): operation is Promise<unknown> => operation !== undefined,
    ),
  );
  const settled = await Promise.allSettled(input.close.map((close) => close()));
  const cleanupFailures = settled.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
  if (input.primaryError !== undefined) {
    if (cleanupFailures.length > 0)
      throw new AggregateError(
        [input.primaryError, ...cleanupFailures],
        `${input.label} and cleanup failed`,
      );
    if (input.primaryError instanceof Error) throw input.primaryError;
    throw new Error(`${input.label} failed`, { cause: input.primaryError });
  }
  if (cleanupFailures.length === 1) throw cleanupFailures[0];
  if (cleanupFailures.length > 1)
    throw new AggregateError(cleanupFailures, `${input.label} cleanup failed`);
}

export async function finishTransactionClient(
  client: PoolClient,
  input: Readonly<{
    label: string;
    primaryError: unknown;
    transactionOpen: boolean;
  }>,
): Promise<void> {
  const cleanupFailures: unknown[] = [];
  let disposalError: Error | undefined;
  if (input.transactionOpen) {
    try {
      await client.query('rollback');
    } catch (error: unknown) {
      disposalError = new Error(`${input.label} rollback failed`, {
        cause: error,
      });
      cleanupFailures.push(disposalError);
    }
  }
  try {
    client.release(disposalError);
  } catch (error: unknown) {
    cleanupFailures.push(error);
  }
  if (input.primaryError !== undefined) {
    if (cleanupFailures.length > 0)
      throw new AggregateError(
        [input.primaryError, ...cleanupFailures],
        `${input.label} and cleanup failed`,
      );
    if (input.primaryError instanceof Error) throw input.primaryError;
    throw new Error(`${input.label} failed`, { cause: input.primaryError });
  }
  if (cleanupFailures.length === 1) {
    const cleanupFailure = cleanupFailures[0];
    if (cleanupFailure instanceof Error) throw cleanupFailure;
    throw new Error(`${input.label} cleanup failed`, {
      cause: cleanupFailure,
    });
  }
  if (cleanupFailures.length > 1)
    throw new AggregateError(cleanupFailures, `${input.label} cleanup failed`);
}

export function withApplicationName(base: string, applicationName: string) {
  const url = new URL(base);
  url.searchParams.set('application_name', applicationName);
  return url.toString();
}

export async function waitForPostgresLock(
  applicationName: string,
): Promise<void> {
  const monitor = new Pool({
    connectionString: adminUrl,
    connectionTimeoutMillis: 1_000,
    max: 1,
  });
  const deadline = performance.now() + 5_000;
  let lastObserved: unknown = null;
  try {
    while (performance.now() < deadline) {
      const result = await monitor.query<{
        blockers: number[];
        pid: number;
      }>(
        `select pid, pg_blocking_pids(pid) blockers
           from pg_stat_activity
          where datname = $1 and application_name = $2
            and wait_event_type = 'Lock'`,
        [databaseName, applicationName],
      );
      lastObserved = result.rows;
      if (
        result.rows.length === 1 &&
        (result.rows[0]?.blockers.length ?? 0) > 0
      )
        return;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      `PostgreSQL application ${applicationName} did not enter the expected lock wait: ${JSON.stringify(lastObserved)}`,
    );
  } finally {
    await monitor.end();
  }
}

export async function currentRepresentationTag(
  database: WorkflowAuthoringDatabase,
  scopedWorkspaceId: string,
  scopedWorkflowId: string,
  scopedActorId: string,
  definitionCatalog?: WorkflowDefinitionCatalog,
): Promise<string> {
  const draft = await database.getDraft(
    scopedWorkspaceId,
    scopedWorkflowId,
    scopedActorId,
  );
  if (draft === null) throw new Error('Expected workflow draft');
  return workflowDraftRepresentationTag({
    workflowId: scopedWorkflowId,
    revision: draft.revision,
    graph: draft.graphJson,
    compatibilityFingerprint:
      definitionCatalog === undefined
        ? draft.compatibility.fingerprint
        : workflowCompatibilityReport(draft.graphJson, definitionCatalog)
            .fingerprint,
  });
}

export async function saveCurrentDraft(
  database: WorkflowAuthoringDatabase,
  input: Omit<
    Parameters<WorkflowAuthoringDatabase['saveDraft']>[0],
    'representationTag'
  >,
) {
  return database.saveDraft({
    ...input,
    representationTag: await currentRepresentationTag(
      database,
      input.workspaceId,
      input.workflowId,
      input.actorId,
    ),
  });
}

export async function executeAsOwner(
  statement: string,
  parameters: readonly unknown[] = [],
): Promise<void> {
  const client = await ownerPool.connect();
  let rollbackFailure: unknown;
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query(statement, [...parameters]);
    await client.query('commit');
  } catch (error: unknown) {
    try {
      await client.query('rollback');
    } catch (rollbackError: unknown) {
      rollbackFailure = rollbackError;
    }
    throw error;
  } finally {
    client.release(
      rollbackFailure === undefined
        ? undefined
        : new Error('Owner fixture rollback failed', {
            cause: rollbackFailure,
          }),
    );
  }
}

export async function queryAsOwner<T extends Record<string, unknown>>(
  statement: string,
  parameters: readonly unknown[] = [],
  scopedWorkspaceId?: string,
): Promise<readonly T[]> {
  const client = await ownerPool.connect();
  let rollbackFailure: unknown;
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    if (scopedWorkspaceId !== undefined) {
      await client.query("select set_config('app.workspace_id', $1, true)", [
        scopedWorkspaceId,
      ]);
    }
    const result = await client.query<T>(statement, [...parameters]);
    await client.query('commit');
    return result.rows;
  } catch (error: unknown) {
    try {
      await client.query('rollback');
    } catch (rollbackError: unknown) {
      rollbackFailure = rollbackError;
    }
    throw error;
  } finally {
    client.release(
      rollbackFailure === undefined
        ? undefined
        : new Error('Owner fixture rollback failed', {
            cause: rollbackFailure,
          }),
    );
  }
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
        otherWorkflowId,
        otherActorId,
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

export {
  CONNECTION_AUTH_TYPE,
  EMPTY_DEFINITION_CATALOG,
  IdempotencyConflictError,
  Pool,
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
  checkDatabaseReadiness,
  createConnectionDatabase,
  createHash,
  createWorkflowAuthoringDatabase,
  createWorkflowIntegrationUsageDatabase,
  parseDatabaseConfig,
  randomUUID,
  workflowCompatibilityReport,
  workflowDraftRepresentationTag,
};
