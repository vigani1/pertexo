import { acquireDatabasePool } from '../../platform/database-runtime.js';

import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  type WorkflowDefinitionPlacementIssue,
  workflowDefinitionPlacementIssues,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import type { WorkflowDefinitionCatalog } from '@pertexo/workflow-model/server';

import type { DatabaseConfig } from '../../config.js';
import { WorkflowNotFoundError } from './errors.js';
import { normalizeWorkflowAuthoringCompatibility } from './compatibility.js';
import { createWorkflowPublisher } from '../publication/publisher.js';
import { createWorkflowAuthoringReadStore } from './reads.js';
import { lockWorkflowAuthoringAuthority } from './authority.js';
import { createWorkflowAuthoringDraftStore } from './commands/drafts.js';
import { createWorkflowVersionRestoreStore } from './commands/version-restore.js';
import { createWorkflowDuplicationStore } from './commands/duplication.js';
import { createWorkflowPortabilityStore } from '../portability/store.js';
import type { WorkflowAuthoringWriteContext } from './context.js';
import { createWorkflowAuthoringLifecycleStore } from './commands/lifecycle.js';
import { createWorkflowAuthoringRenameStore } from './commands/rename.js';
import { createWorkflowAutoPauseStore } from '../settings/auto-pause.js';
import { createWorkflowConcurrencyStore } from '../settings/concurrency.js';
export type {
  WorkflowDraftRecord,
  WorkflowRecord,
  WorkflowVersionRecord,
} from './records.js';
import {
  acceptPreviewRun,
  readPreviewRun,
  resolvePreviewReplay,
} from '../../previews/repository.js';
import {
  withTenantScopedClient,
  withWorkspaceTransaction,
} from '../../tenant-access/workspace.js';
import { rolesForCapability } from '../../tenant-access/workspace-policy.js';
import type { WorkflowAuthoringDatabaseOptions } from './types.js';
export type {
  WorkflowAuthoringDatabaseOptions,
  WorkflowAuthoringTestHooks,
} from './types.js';

const uuidSchema = z.uuid();

export {
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
  WorkflowLifecycleRevisionConflictError,
  WorkflowNameRevisionConflictError,
  WorkflowPortabilityUnavailableError,
  WorkflowTemplateOriginUnavailableError,
  WorkflowPortabilityCompatibilityConflictError,
  WorkflowPortabilityReviewConflictError,
  WorkflowPortabilityValidationError,
} from './errors.js';
export type {
  TransitionWorkflowLifecycleInput,
  TransitionWorkflowLifecycleResult,
  WorkflowLifecycleCommand,
} from './contracts.js';
import type { WorkflowAuthoringDatabase } from './contracts.js';

export type { WorkflowDefinitionPlacementIssue } from '@pertexo/workflow-model';

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
} from './contracts.js';

export { reconcileWorkflowTriggersPayload } from '../publication/publisher.js';

function requirePlaceableDefinitionAdditions(
  previous: WorkflowGraph,
  next: WorkflowGraph,
  placementCatalog: WorkflowDefinitionCatalog | undefined,
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
    requireAuthor: requireWorkspaceAuthor,
    requirePlaceable: requirePlaceableDefinitionAdditions,
    selectCatalogs: selectCompatibilityVariant,
    ...(options.testHooks === undefined
      ? {}
      : { testHooks: options.testHooks }),
    transact,
  };
  const publishWorkflow = createWorkflowPublisher({
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
