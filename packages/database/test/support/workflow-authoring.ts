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
} from '../../src/connections/database.js';
import { createIdentityWorkspaceDatabase } from '../../src/tenant-access/database.js';
import { migrateDatabase } from '../../src/migrations.js';
import { IdempotencyConflictError } from '../../src/platform/idempotency.js';
import { checkDatabaseReadiness } from '../../src/platform/readiness.js';
import {
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
  type WorkflowAuthoringDatabase,
} from '../../src/authoring/workflows/database.js';
import { createWorkflowAuthoringFixtureDatabase as createWorkflowAuthoringDatabase } from './workflow-authoring-admission.fixture.js';
import { createWorkflowIntegrationUsageDatabase } from '../../src/connections/integration-usage.queries.js';
import { createDisposableDatabaseFixture } from './postgres/disposable-database.js';
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
  definitions: Object.freeze([
    Object.freeze({ key: 'test.placeholder', version: 1 }),
  ]),
});
export const baselineEmptyDefinitionCatalog = Object.freeze({
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

/** A row write a command makes; tests hold or fail the command there. */
export type WritePoint = Readonly<{
  table: string;
  operation: 'insert' | 'update' | 'insert or update';
  /** Trigger condition on the written row, e.g. `NEW.workflow_id = '…'`. */
  when?: string;
}>;

let writePointSequence = 0;

async function asAdmin<T>(work: (client: PoolClient) => Promise<T>) {
  const pool = new Pool({ connectionString: adminDatabaseUrl, max: 1 });
  try {
    const client = await pool.connect();
    try {
      return await work(client);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

/**
 * Installs an AFTER ROW trigger at the write in this disposable database, so
 * tests reach inside a command's transaction without hooks in the code under
 * test. Returns the trigger's removal.
 */
async function installWritePoint(
  point: WritePoint,
  body: string,
): Promise<() => Promise<void>> {
  writePointSequence += 1;
  const name = `test_write_point_${String(writePointSequence)}`;
  await asAdmin(async (client) => {
    await client.query(
      `create function app.${name}() returns trigger language plpgsql
       as $$ begin ${body} return null; end $$`,
    );
    await client.query(
      `create trigger ${name} after ${point.operation} on app.${point.table}
       for each row ${point.when === undefined ? '' : `when (${point.when})`}
       execute function app.${name}()`,
    );
  });
  return () =>
    asAdmin(async (client) => {
      await client.query(
        `drop trigger if exists ${name} on app.${point.table}`,
      );
      await client.query(`drop function if exists app.${name}()`);
    });
}

/** Fails the command at this write, so its transaction rolls back. */
export async function failAtWrite(
  point: WritePoint,
): Promise<Readonly<{ message: string; remove: () => Promise<void> }>> {
  const message = `injected failure at ${point.table} ${point.operation}`;
  const remove = await installWritePoint(
    point,
    `raise exception '${message}';`,
  );
  return { message, remove };
}

/**
 * Holds the command just after this write, with every lock it has taken,
 * until released. Later writes at the point pass once it is released.
 */
export async function holdAtWrite(point: WritePoint): Promise<
  Readonly<{
    /** Resolves once a command waits at the point. */
    reached: () => Promise<void>;
    release: () => Promise<void>;
    remove: () => Promise<void>;
  }>
> {
  const key = 1_000_000 + Math.floor(Math.random() * 1_000_000_000);
  const holder = new Pool({ connectionString: adminDatabaseUrl, max: 2 });
  const client = await holder.connect();
  await client.query('select pg_advisory_lock($1)', [key]);
  const remove = await installWritePoint(
    point,
    `perform pg_advisory_xact_lock(${String(key)});`,
  );
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    try {
      await client.query('select pg_advisory_unlock($1)', [key]);
    } finally {
      client.release();
      await holder.end();
    }
  };
  return {
    reached: async () => {
      const deadline = performance.now() + 5_000;
      while (performance.now() < deadline) {
        const waiting = await holder.query(
          `select 1 from pg_locks where locktype = 'advisory'
             and objid = $1 and not granted`,
          [key],
        );
        if (waiting.rowCount !== 0) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`No command reached ${point.table} ${point.operation}`);
    },
    release,
    remove: async () => {
      await release();
      await remove();
    },
  };
}

/** The writes a publication makes, in order, for one workflow. */
export function publicationWrite(
  step:
    | 'version'
    | 'integration_usage'
    | 'trigger_projection'
    | 'pointer'
    | 'outbox'
    | 'audit'
    | 'idempotency',
  workflow: string,
): WritePoint {
  switch (step) {
    case 'version':
      return {
        table: 'workflow_versions',
        operation: 'insert',
        when: `NEW.workflow_id = '${workflow}'`,
      };
    case 'integration_usage':
      return { table: 'workflow_integration_usage', operation: 'insert' };
    case 'trigger_projection':
      return {
        table: 'workflow_triggers',
        operation: 'insert or update',
        when: `NEW.workflow_id = '${workflow}'`,
      };
    case 'pointer':
      return {
        table: 'workflows',
        operation: 'update',
        when: `NEW.id = '${workflow}' and NEW.published_version_id is distinct from OLD.published_version_id`,
      };
    case 'outbox':
      return {
        table: 'outbox_events',
        operation: 'insert',
        when: `NEW.aggregate_id = '${workflow}'`,
      };
    case 'audit':
      return {
        table: 'audit_events',
        operation: 'insert',
        when: `NEW.target_id = '${workflow}' and NEW.action = 'workflow.published'`,
      };
    case 'idempotency':
      return {
        table: 'idempotency_records',
        operation: 'update',
        when: `NEW.resource_id = '${workflow}' and NEW.status = 'completed'`,
      };
  }
}

/** The writes an archive makes, in order, for one workflow. */
export function archiveWrite(
  step: 'claim' | 'workflow' | 'outbox' | 'audit' | 'idempotency',
  workflow: string,
): WritePoint {
  const claim = `NEW.resource_id = '${workflow}' and NEW.operation = 'workflow.archive'`;
  switch (step) {
    case 'claim':
      return { table: 'idempotency_records', operation: 'insert', when: claim };
    case 'workflow':
      return {
        table: 'workflows',
        operation: 'update',
        when: `NEW.id = '${workflow}' and NEW.lifecycle_status is distinct from OLD.lifecycle_status`,
      };
    case 'outbox':
      return {
        table: 'outbox_events',
        operation: 'insert',
        when: `NEW.aggregate_id = '${workflow}'`,
      };
    case 'audit':
      return {
        table: 'audit_events',
        operation: 'insert',
        when: `NEW.target_id = '${workflow}' and NEW.action = 'workflow.archived'`,
      };
    case 'idempotency':
      return {
        table: 'idempotency_records',
        operation: 'update',
        when: `${claim} and NEW.status = 'completed'`,
      };
  }
}

/** The writes a rename makes, in order, for one workflow. */
export function renameWrite(
  step: 'claim' | 'workflow' | 'audit' | 'idempotency',
  workflow: string,
): WritePoint {
  const claim = `NEW.resource_id = '${workflow}' and NEW.operation = 'workflow.rename'`;
  switch (step) {
    case 'claim':
      return { table: 'idempotency_records', operation: 'insert', when: claim };
    case 'workflow':
      return {
        table: 'workflows',
        operation: 'update',
        when: `NEW.id = '${workflow}' and NEW.name is distinct from OLD.name`,
      };
    case 'audit':
      return {
        table: 'audit_events',
        operation: 'insert',
        when: `NEW.target_id = '${workflow}' and NEW.action = 'workflow.renamed'`,
      };
    case 'idempotency':
      return {
        table: 'idempotency_records',
        operation: 'update',
        when: `${claim} and NEW.status = 'completed'`,
      };
  }
}

/** A workflow's draft save, the write a save or version restore makes. */
export function draftWrite(workflow: string): WritePoint {
  return {
    table: 'workflow_drafts',
    operation: 'update',
    when: `NEW.workflow_id = '${workflow}'`,
  };
}

/** The writes a duplication makes, in order; one copy runs at a time. */
export function duplicateWrite(
  step: 'claim' | 'workflow' | 'draft' | 'audit' | 'idempotency',
  copyName: string,
): WritePoint {
  const claim = `NEW.operation = 'workflow.duplicate'`;
  switch (step) {
    case 'claim':
      return { table: 'idempotency_records', operation: 'insert', when: claim };
    case 'workflow':
      return {
        table: 'workflows',
        operation: 'insert',
        when: `NEW.name = '${copyName.replaceAll("'", "''")}'`,
      };
    case 'draft':
      return { table: 'workflow_drafts', operation: 'insert' };
    case 'audit':
      return {
        table: 'audit_events',
        operation: 'insert',
        when: `NEW.action = 'workflow.duplicated'`,
      };
    case 'idempotency':
      return {
        table: 'idempotency_records',
        operation: 'update',
        when: `${claim} and NEW.status = 'completed'`,
      };
  }
}

/** The writes an import makes, in order; one import runs at a time. */
export function importWrite(
  step: 'claim' | 'workflow' | 'draft' | 'audit' | 'idempotency',
  name: string,
): WritePoint {
  const claim = `NEW.operation = 'workflow.import'`;
  switch (step) {
    case 'claim':
      return { table: 'idempotency_records', operation: 'insert', when: claim };
    case 'workflow':
      return {
        table: 'workflows',
        operation: 'insert',
        when: `NEW.name = '${name.replaceAll("'", "''")}'`,
      };
    case 'draft':
      return { table: 'workflow_drafts', operation: 'insert' };
    case 'audit':
      return {
        table: 'audit_events',
        operation: 'insert',
        when: `NEW.action = 'workflow.imported'`,
      };
    case 'idempotency':
      return {
        table: 'idempotency_records',
        operation: 'update',
        when: `${claim} and NEW.status = 'completed'`,
      };
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
