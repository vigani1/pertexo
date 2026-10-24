import type { FolderScope } from '../../tenant-access/resources/contract.js';
import { WorkspaceAccessDeniedError } from '../../tenant-access/errors.js';
import { readFolderScope } from '../../tenant-access/resources/facts.js';
import { lockWorkspaceAuthority } from '../../tenant-access/workspaces/authority.js';
import { ROLES } from '@pertexo/workflow-model';
import { createWorkflowCollaborationStore } from '../collaboration/store.js';
import { createWorkflowPromotionStore } from '../promotion/store.js';
import { createPublicationReviewStore } from '../reviews/store.js';
import { createWorkflowTestSuiteStore } from '../../previews/suites/repository.js';
import { createWorkflowTestStore } from '../../previews/workflows/repository.js';
import { createWorkflowStepSampleStore } from '../step-samples/store.js';
import { createWorkflowErrorStore } from '../settings/error-workflow.js';
import { acquireDatabasePool } from '../../platform/pool/runtime.js';

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
import { authoringCatalogs } from './catalogs.js';
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
import { createWorkflowAutoPauseStore } from '../settings/auto-pause/store.js';
import { createWorkflowConcurrencyStore } from '../settings/concurrency.js';
export type {
  WorkflowDraftRecord,
  WorkflowRecord,
  WorkflowVersionRecord,
} from './representation/records.js';
import { acceptPreviewRun } from '../../previews/runs/acceptance.repository.js';
import { readPreviewRun } from '../../previews/runs/records.queries.js';
import { resolvePreviewReplay } from '../../previews/runs/replay.repository.js';
import {
  withTenantScopedClient,
  withMultiWorkspaceTransaction,
  type WorkspaceScopeRunner,
  withWorkspaceTransaction,
} from '../../tenant-access/transactions.js';
import { rolesForCapability } from '@pertexo/workflow-model';
import type { WorkflowAuthoringDatabaseOptions } from './types.js';
export type { WorkflowAuthoringDatabaseOptions } from './types.js';

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
  {
    actorIdInput,
    operation,
    signal,
  }: Readonly<{
    actorIdInput: string;
    operation: (client: PoolClient) => Promise<T>;
    signal?: AbortSignal | undefined;
  }>,
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
  {
    actorId,
    workflowId,
    capability = 'workflow:update',
  }: Readonly<{
    actorId: string;
    workflowId?: string | undefined;
    capability?: ('workflow:read' | 'workflow:update') | undefined;
  }>,
): Promise<void> {
  await lockWorkflowAuthoringAuthority(client, workspaceId, {
    actorId,
    roles: rolesForCapability('workflow:update'),
    resource: workflowId === undefined ? undefined : { workflowId, capability },
  });
}

async function requireWorkspaceReader(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
): Promise<FolderScope> {
  try {
    const role = await lockWorkspaceAuthority(
      client,
      workspaceId,
      actorId,
      ROLES,
    );
    return await readFolderScope(client, { workspaceId, actorId }, role);
  } catch (error) {
    if (error instanceof WorkspaceAccessDeniedError)
      throw new WorkflowNotFoundError('Workflow is not visible');
    throw error;
  }
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
  options: WorkflowAuthoringDatabaseOptions,
): WorkflowAuthoringDatabase {
  const catalogs = authoringCatalogs(options);
  const lease = acquireDatabasePool(config, options.runtime);
  const { pool } = lease;
  const authoringOperations = new Set<Promise<unknown>>();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  async function tracked<T>(start: () => Promise<T>): Promise<T> {
    if (closed) throw new Error('Workflow authoring database is closed');
    const pending = start();
    authoringOperations.add(pending);
    try {
      return await pending;
    } finally {
      authoringOperations.delete(pending);
    }
  }
  function transact<T>(
    workspaceId: string,
    actorId: string,
    operation: (client: PoolClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return tracked(() =>
      withAuthorTransaction(pool, workspaceId, {
        actorIdInput: actorId,
        operation,
        signal,
      }),
    );
  }
  function transactScopes<T>(
    operation: (inWorkspace: WorkspaceScopeRunner) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return tracked(() =>
      withMultiWorkspaceTransaction(
        pool,
        operation,
        signal === undefined ? {} : { signal },
      ),
    );
  }
  const authoringContext: WorkflowAuthoringWriteContext = {
    requireAuthor: requireWorkspaceAuthor,
    requirePlaceable: requirePlaceableDefinitionAdditions,
    catalogs,
    transact,
  };
  const publishWorkflow = createWorkflowPublisher({
    requireAuthor: requireWorkspaceAuthor,
    catalogs,
    transact,
  });
  return Object.freeze({
    collaboration: createWorkflowCollaborationStore(authoringContext),
    promotions: createWorkflowPromotionStore({
      ...authoringContext,
      transactScopes,
    }),
    publicationReviews: createPublicationReviewStore(authoringContext),
    stepSamples: createWorkflowStepSampleStore(pool),
    workflowTests: createWorkflowTestStore(pool, catalogs),
    workflowTestSuites: createWorkflowTestSuiteStore(pool, catalogs),
    autoPause: createWorkflowAutoPauseStore(transact),
    concurrency: createWorkflowConcurrencyStore(transact),
    errorWorkflow: createWorkflowErrorStore(transact),
    ...createPreviewStore(pool),
    ...createWorkflowAuthoringDraftStore(authoringContext),
    ...createWorkflowVersionRestoreStore(authoringContext),
    ...createWorkflowDuplicationStore(authoringContext),
    ...createWorkflowPortabilityStore(authoringContext),
    ...createWorkflowAuthoringReadStore({
      requireReader: requireWorkspaceReader,
      catalogs,
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
