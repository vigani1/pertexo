import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll } from 'vitest';
import {
  EMPTY_DEFINITION_CATALOG_V1,
  workflowCompatibilityReport,
  workflowDraftRepresentationTag,
  type WorkflowDefinitionCatalogV1,
} from '@pertexo/workflow-model/graph';

import { parseDatabaseConfig } from '../../src/config.js';
import {
  CONNECTION_AUTH_TYPE,
  createConnectionDatabase,
} from '../../src/connections/connections.js';
import { CompatibilityReleaseMismatchError } from '../../src/compatibility/compatibility-release.js';
import { createIdentityWorkspaceDatabase } from '../../src/identity-workspace.js';
import { migrateDatabase } from '../../src/migrations.js';
import { PHASE3_COMPATIBILITY_EXPECTATION } from '../phase3-compatibility-fixture.js';
import { checkDatabaseReadiness } from '../../src/readiness.js';
import {
  createWorkflowAuthoringDatabase,
  WorkflowIdempotencyConflictError,
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
  type WorkflowAuthoringDatabase,
} from '../../src/workflow-authoring.js';
import { createWorkflowIntegrationUsageDatabase } from '../../src/connections/workflow-integration-usage.js';

export const migrationUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
export const apiUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
export const workerUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';
export const dispatcherUrl =
  process.env.DATABASE_DISPATCHER_URL ??
  'postgresql://pertexo_dispatcher:pertexo-local-dispatcher@localhost:5432/pertexo';
export const migrationConfig = {
  apiRuntimeRole: 'pertexo_api',
  connectionString: migrationUrl,
  dispatcherRole: 'pertexo_dispatcher',
  maintenanceRole: 'pertexo_maintenance',
  lifecycleCommandRole: 'pertexo_lifecycle_command',
  operatorRole: 'pertexo_operator',
  ownerRole: 'pertexo_owner',
  workerRuntimeRole: 'pertexo_worker',
} as const;

export const identity = createIdentityWorkspaceDatabase(
  parseDatabaseConfig({ connectionString: apiUrl, max: 4 }),
);
export const ownerPool = new Pool({ connectionString: migrationUrl, max: 1 });
export const apiPool = new Pool({ connectionString: apiUrl, max: 1 });
export const workerPool = new Pool({ connectionString: workerUrl, max: 1 });
export const dispatcherPool = new Pool({
  connectionString: dispatcherUrl,
  max: 1,
});
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
export const phase3EmptyDefinitionCatalog = Object.freeze({
  schemaVersion: 1 as const,
  releaseFingerprint: PHASE3_COMPATIBILITY_EXPECTATION.fingerprint,
  definitions: Object.freeze([]),
});
export const authoring = createWorkflowAuthoringDatabase(
  parseDatabaseConfig({ connectionString: apiUrl, max: 4 }),
);

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

export function withApplicationName(base: string, applicationName: string) {
  const url = new URL(base);
  url.searchParams.set('application_name', applicationName);
  return url.toString();
}

export async function waitForPostgresLock(
  applicationName: string,
): Promise<void> {
  const monitor = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const result = await monitor.query<{ blocked: boolean }>(
        `select exists (
           select 1
             from pg_stat_activity
            where application_name = $1
              and wait_event_type = 'Lock'
         ) as blocked`,
        [applicationName],
      );
      if (result.rows[0]?.blocked === true) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error(`PostgreSQL application ${applicationName} did not block`);
  } finally {
    await monitor.end();
  }
}

export async function currentRepresentationTag(
  database: WorkflowAuthoringDatabase,
  scopedWorkspaceId: string,
  scopedWorkflowId: string,
  scopedActorId: string,
  definitionCatalog: WorkflowDefinitionCatalogV1 = EMPTY_DEFINITION_CATALOG_V1,
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
    compatibilityFingerprint: workflowCompatibilityReport(
      draft.graphJson,
      definitionCatalog,
    ).fingerprint,
  });
}

export async function executeAsOwner(
  statement: string,
  parameters: readonly unknown[] = [],
): Promise<void> {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query(statement, [...parameters]);
    await client.query('commit');
  } catch (error: unknown) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function queryAsOwner<T extends Record<string, unknown>>(
  statement: string,
  parameters: readonly unknown[] = [],
  scopedWorkspaceId?: string,
): Promise<readonly T[]> {
  const client = await ownerPool.connect();
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
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  await migrateDatabase(migrationConfig);
  await executeAsOwner(
    `update app.node_compatibility_current
        set epoch = $1,
            fingerprint = $2,
            activated_by_kind = 'migration',
            activated_by = 'workflow-authoring-integration',
            activated_at = transaction_timestamp(),
            activation_approval_id = null
      where singleton`,
    [
      PHASE3_COMPATIBILITY_EXPECTATION.epoch,
      PHASE3_COMPATIBILITY_EXPECTATION.fingerprint,
    ],
  );
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
});

afterAll(async () => {
  await authoring.close();
  await identity.close();
  await ownerPool.end();
  await apiPool.end();
  await workerPool.end();
  await dispatcherPool.end();
});

export {
  CONNECTION_AUTH_TYPE,
  CompatibilityReleaseMismatchError,
  EMPTY_DEFINITION_CATALOG_V1,
  PHASE3_COMPATIBILITY_EXPECTATION,
  Pool,
  WorkflowIdempotencyConflictError,
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
