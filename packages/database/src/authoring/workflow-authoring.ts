import { acquireDatabasePool } from '../platform/database-runtime.js';
import { createHash } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type {
  WorkflowDefinitionCatalogV1,
  WorkflowGraph,
  WorkflowDefinitionPlacementIssue,
} from '@pertexo/workflow-model/graph';
import { workflowDefinitionPlacementIssues } from '@pertexo/workflow-model/graph';

import type { DatabaseConfig } from '../config.js';
import { WorkflowNotFoundError } from './workflow-authoring-errors.js';
import { normalizeWorkflowAuthoringCompatibility } from './workflow-authoring-compatibility.js';
import { createWorkflowPublisher } from './workflow-publication.js';
import { createWorkflowAuthoringReadStore } from './workflow-authoring-reads.js';
import { lockWorkflowAuthoringAuthority } from './workflow-authoring-authority.js';
import { createWorkflowAuthoringDraftStore } from './workflow-authoring-drafts.js';
import { createWorkflowVersionRestoreStore } from './workflow-authoring-version-restore.js';
import { createWorkflowDuplicationStore } from './workflow-authoring-duplication.js';
import { createWorkflowPortabilityStore } from './workflow-authoring-portability.js';
import type { WorkflowAuthoringWriteContext } from './workflow-authoring-context.js';
import { createWorkflowAuthoringLifecycleStore } from './workflow-authoring-lifecycle.js';
import { createWorkflowAuthoringRenameStore } from './workflow-authoring-rename.js';
import { createWorkflowAutoPauseStore } from './workflow-auto-pause.js';
import { createWorkflowConcurrencyStore } from './workflow-concurrency.js';
export type {
  WorkflowDraftRecord,
  WorkflowRecord,
  WorkflowVersionRecord,
} from './workflow-authoring-records.js';
import { checksumSchema, mapVersion } from './workflow-authoring-rows.js';
import {
  acceptPreviewRun,
  readPreviewRun,
  resolvePreviewReplay,
} from '../execution/previews/preview-execution.js';
import {
  withTenantScopedClient,
  withWorkspaceTransaction,
} from '../tenant-access/workspace.js';
import { rolesForCapability } from '../tenant-access/workspace-policy.js';
import type { WorkflowAuthoringDatabaseOptions } from './workflow-authoring-types.js';
export type {
  WorkflowAuthoringDatabaseOptions,
  WorkflowAuthoringTestHooks,
} from './workflow-authoring-types.js';

const uuidSchema = z.uuid();
const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/u)
  .refine((value) => !value.includes(','));

export {
  WorkflowIdempotencyConflictError,
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
  WorkflowLifecycleRevisionConflictError,
  WorkflowNameRevisionConflictError,
  WorkflowPortabilityUnavailableError,
  WorkflowDraftOperationUnavailableError,
  WorkflowTemplateOriginUnavailableError,
  WorkflowPortabilityCompatibilityConflictError,
  WorkflowPortabilityReviewConflictError,
  WorkflowPortabilityValidationError,
} from './workflow-authoring-errors.js';
export type {
  TransitionWorkflowLifecycleInput,
  TransitionWorkflowLifecycleResult,
  WorkflowLifecycleCommand,
} from './workflow-authoring-contracts.js';
import type {
  PublishWorkflowResult,
  WorkflowAuthoringDatabase,
} from './workflow-authoring-contracts.js';

export type { WorkflowDefinitionPlacementIssue } from '@pertexo/workflow-model/graph';

export class WorkflowDefinitionPlacementError extends Error {
  public override readonly name = 'WorkflowDefinitionPlacementError';

  public constructor(
    public readonly issues: readonly WorkflowDefinitionPlacementIssue[],
  ) {
    super('Workflow draft adds a definition that is not placeable');
  }
}

export type {
  CreateWorkflowInput,
  CreateWorkflowResult,
  DuplicateWorkflowInput,
  DuplicateWorkflowResult,
  ExportWorkflowInput,
  PreviewWorkflowImportInput,
  PreviewWorkflowImportResult,
  ImportWorkflowInput,
  ImportWorkflowResult,
  ListWorkflowsInput,
  ListWorkflowVersionsInput,
  PublishWorkflowInput,
  PublishWorkflowResult,
  RestoreWorkflowVersionInput,
  SaveWorkflowDraftInput,
  WorkflowAuthoringDatabase,
  WorkflowPage,
  WorkflowVersionPage,
} from './workflow-authoring-contracts.js';

export { reconcileWorkflowTriggersPayload } from './workflow-publication.js';

function requirePlaceableDefinitionAdditions(
  previous: WorkflowGraph,
  next: WorkflowGraph,
  placementCatalog: WorkflowDefinitionCatalogV1 | undefined,
): void {
  if (placementCatalog === undefined) return;
  const issues = workflowDefinitionPlacementIssues(
    previous,
    next,
    placementCatalog,
  );
  if (issues.length > 0)
    throw new WorkflowDefinitionPlacementError(Object.freeze(issues));
}

async function withAuthorTransaction<T>(
  pool: Pool,
  workspaceIdInput: string,
  actorIdInput: string,
  operation: (client: PoolClient) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return withTenantScopedClient(
    pool,
    {
      workspaceId: uuidSchema.parse(workspaceIdInput),
      actorId: uuidSchema.parse(actorIdInput),
    },
    operation,
    signal === undefined ? {} : { signal },
  );
}

async function requireWorkspaceAuthor(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
): Promise<void> {
  await lockWorkflowAuthoringAuthority(
    client,
    workspaceId,
    actorId,
    rolesForCapability('workflow:update'),
  );
}

async function requireWorkspaceReader(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
): Promise<void> {
  const result = await client.query(
    `select 1 from app.workspace_memberships membership
     join app.users actor on actor.id = membership.user_id
     join app.workspaces workspace on workspace.id = membership.workspace_id
     where membership.workspace_id = $1 and membership.user_id = $2
       and membership.status = 'active' and actor.status = 'active'
       and workspace.status = 'active'`,
    [workspaceId, actorId],
  );
  if (result.rowCount !== 1)
    throw new WorkflowNotFoundError('Workflow is not visible');
}

function keyDigest(key: string): string {
  return createHash('sha256')
    .update(idempotencyKeySchema.parse(key))
    .digest('hex');
}

function durablePublishResult(
  value: unknown,
  expectedWorkspaceId: string,
  expectedWorkflowId: string,
): Omit<PublishWorkflowResult, 'replayed'> {
  const parsed = z
    .object({
      version: z
        .object({
          id: z.uuid(),
          workspaceId: z.uuid(),
          workflowId: z.uuid(),
          versionNumber: z.number().int().positive(),
          schemaVersion: z.number().int().positive(),
          graphJson: z.unknown(),
          checksum: checksumSchema,
          publishedBy: z.uuid(),
          publishedAt: z.iso.datetime(),
        })
        .strict(),
      reused: z.boolean(),
    })
    .strict()
    .parse(value);
  if (
    parsed.version.workspaceId !== expectedWorkspaceId ||
    parsed.version.workflowId !== expectedWorkflowId
  )
    throw new Error(
      'Durable workflow publication result identity does not match its claim',
    );
  const version = mapVersion({
    id: parsed.version.id,
    workspace_id: parsed.version.workspaceId,
    workflow_id: parsed.version.workflowId,
    version_number: parsed.version.versionNumber,
    schema_version: parsed.version.schemaVersion,
    graph_json: parsed.version.graphJson,
    checksum: parsed.version.checksum,
    published_by: parsed.version.publishedBy,
    published_at: parsed.version.publishedAt,
  });
  return Object.freeze({
    version,
    reused: parsed.reused,
  });
}

function createPreviewStore(
  pool: Pool,
): Pick<
  WorkflowAuthoringDatabase,
  'acceptPreview' | 'readPreview' | 'resolvePreviewReplay'
> {
  return {
    acceptPreview: async ({ workspaceId, ...input }) =>
      withWorkspaceTransaction(pool, workspaceId, (transaction) =>
        acceptPreviewRun(transaction, input),
      ),
    readPreview: async ({ workspaceId, ...input }) =>
      withWorkspaceTransaction(pool, workspaceId, (transaction) =>
        readPreviewRun(transaction, input),
      ),
    resolvePreviewReplay: async ({ workspaceId, ...input }) =>
      withWorkspaceTransaction(pool, workspaceId, (transaction) =>
        resolvePreviewReplay(transaction, input),
      ),
  };
}

export function createWorkflowAuthoringDatabase(
  config: DatabaseConfig,
  options: WorkflowAuthoringDatabaseOptions = {},
): WorkflowAuthoringDatabase {
  const compatibility = normalizeWorkflowAuthoringCompatibility(options);
  const selectCompatibilityVariant = compatibility.selectLocked;
  const lease = acquireDatabasePool(config, options.runtime);
  const { pool } = lease;
  const authoringOperations = new Set<Promise<unknown>>();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  async function transact<T>(
    workspaceId: string,
    actorId: string,
    operation: (client: PoolClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (closed) throw new Error('Workflow authoring database is closed');
    const pending = withAuthorTransaction(
      pool,
      workspaceId,
      actorId,
      operation,
      signal,
    );
    authoringOperations.add(pending);
    try {
      return await pending;
    } finally {
      authoringOperations.delete(pending);
    }
  }
  const authoringContext: WorkflowAuthoringWriteContext = {
    keyDigest,
    requireAuthor: requireWorkspaceAuthor,
    requirePlaceable: requirePlaceableDefinitionAdditions,
    selectCatalogs: selectCompatibilityVariant,
    ...(options.testHooks === undefined
      ? {}
      : { testHooks: options.testHooks }),
    transact,
  };
  const publishWorkflow = createWorkflowPublisher({
    durableResult: durablePublishResult,
    keyDigest,
    requireAuthor: requireWorkspaceAuthor,
    selectVariant: selectCompatibilityVariant,
    testHooks: options.testHooks,
    transact,
  });
  return Object.freeze({
    autoPause: createWorkflowAutoPauseStore(transact),
    concurrency: createWorkflowConcurrencyStore(transact),
    ...createPreviewStore(pool),
    ...createWorkflowAuthoringDraftStore(authoringContext),
    ...createWorkflowVersionRestoreStore(authoringContext),
    ...createWorkflowDuplicationStore(authoringContext),
    ...createWorkflowPortabilityStore(authoringContext),
    ...createWorkflowAuthoringReadStore({
      requireReader: requireWorkspaceReader,
      selectDefinitionCatalog: async (client) =>
        (await selectCompatibilityVariant(client)).definitionCatalog,
      selectValidationVariant: selectCompatibilityVariant,
      transact,
    }),
    publishWorkflow,
    ...createWorkflowAuthoringLifecycleStore(authoringContext),
    ...createWorkflowAuthoringRenameStore(authoringContext),
    close: () => {
      closed = true;
      closePromise ??= Promise.allSettled([...authoringOperations]).then(() =>
        lease.close(),
      );
      return closePromise;
    },
  });
}
