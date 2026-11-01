import { ROLES } from '@pertexo/workflow-model';
import { acquireDatabasePool } from '@pertexo/database/platform';
import { createWorkflowTestSuiteStore } from '../../previews/suites/store.js';
import { createWorkflowTestStore } from '../../previews/workflows/store.js';
import { WorkspaceAccessDeniedError } from '../../tenant-access/errors.js';
import type { FolderScope } from '../../tenant-access/resources/contract.js';
import { readFolderScope } from '../../shared/facts.queries.js';
import { lockBrowsableWorkspaceAuthority } from '../../shared/authority.queries.js';
import { createWorkflowCollaborationStore } from '../collaboration/repository.js';
import { createWorkflowPromotionStore } from '../promotion/repository.js';
import { createPublicationReviewStore } from '../reviews/repository.js';
import { createWorkflowErrorStore } from '../settings/error-workflow.repository.js';
import { createWorkflowStepSampleStore } from '../step-samples/repository.js';
import { WorkflowDefinitionPlacementError } from './errors.js';

import {
  workflowDefinitionPlacementIssues,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import type { WorkflowDefinitionCatalog } from '@pertexo/workflow-model/server';
import type { Pool, PoolClient } from 'pg';

import { rolesForCapability } from '@pertexo/workflow-model';
import type { DatabaseConfig } from '@pertexo/database/platform';
import { createPreviewRunStore } from '../../previews/runs/store.js';
import {
  withMultiWorkspaceTransaction,
  withTenantScopedClient,
  type WorkspaceScopeRunner,
} from '@pertexo/database/primitives';
import { createWorkflowPortabilityStore } from '../portability/repository.js';
import { createWorkflowPublisher } from '../publication/publisher.repository.js';
import { createWorkflowAutoPauseStore } from '../settings/auto-pause/repository.js';
import { createWorkflowConcurrencyStore } from '../settings/concurrency.repository.js';
import { lockWorkflowAuthoringAuthority } from './authority.js';
import { authoringCatalogs } from './catalogs.js';
import { createWorkflowAuthoringDraftStore } from './commands/drafts.repository.js';
import { createWorkflowDuplicationStore } from './commands/duplication.repository.js';
import { createWorkflowAuthoringLifecycleStore } from './commands/lifecycle.repository.js';
import { createWorkflowAuthoringRenameStore } from './commands/rename.repository.js';
import { createWorkflowVersionRestoreStore } from './commands/version-restore.repository.js';
import type { WorkflowAuthoringWriteContext } from './context.js';
import { WorkflowNotFoundError } from './errors.js';
import { createWorkflowAuthoringReadStore } from './reads.queries.js';
import type { WorkflowAuthoringDatabaseOptions } from './types.js';

import type { WorkflowAuthoringDatabase } from './contract.js';

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
      workspaceId: workspaceIdInput,
      actorId: actorIdInput,
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
    const role = await lockBrowsableWorkspaceAuthority(
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
    ...createPreviewRunStore(pool),
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
