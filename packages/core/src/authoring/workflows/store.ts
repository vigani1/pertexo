import { acquireDatabasePool } from '@pertexo/database/platform';
import type { DatabaseConfig } from '@pertexo/database/platform';
import {
  withMultiWorkspaceTransaction,
  withTenantScopedClient,
  type WorkspaceScopeRunner,
} from '@pertexo/database/primitives';
import { createPreviewRunStore } from '../../previews/runs/store.js';
import { createWorkflowTestSuiteStore } from '../../previews/suites/store.js';
import { createWorkflowTestStore } from '../../previews/workflows/store.js';
import { createWorkflowCollaborationStore } from '../collaboration/store.js';
import { createWorkflowPortabilityStore } from '../portability/store.js';
import { readWorkflowWithTemplateOrigin } from '../portability/template-origin.queries.js';
import { createWorkflowPromotionStore } from '../promotion/store.js';
import { publishWorkflow } from '../publication/publish.js';
import { createPublicationReviewStore } from '../reviews/store.js';
import { createWorkflowAutoPauseStore } from '../settings/auto-pause/store.js';
import { createWorkflowConcurrencyStore } from '../settings/concurrency/store.js';
import { createWorkflowErrorStore } from '../settings/error-workflow/store.js';
import { createWorkflowStepSampleStore } from '../step-samples/store.js';
import { createAuthoringAccess } from './access.js';
import { authoringCatalogs } from './catalogs.js';
import { createWorkflow } from './commands/create.js';
import { duplicateWorkflow } from './commands/duplicate.js';
import { renameWorkflow } from './commands/rename.js';
import { restoreWorkflowVersion } from './commands/restore-version.js';
import { saveDraft } from './commands/save-draft.js';
import { transitionWorkflowLifecycle } from './commands/transition-lifecycle.js';
import type {
  CreateWorkflowInput,
  DuplicateWorkflowInput,
  ListWorkflowVersionsInput,
  ListWorkflowsInput,
  PublishWorkflowInput,
  RenameWorkflowInput,
  RestoreWorkflowVersionInput,
  SaveWorkflowDraftInput,
  TransitionWorkflowLifecycleInput,
} from './contract.js';
import { readDraft, validateDraft } from './reads/drafts.queries.js';
import { listVersions, readVersion } from './reads/versions.queries.js';
import { listWorkflows, readWorkflow } from './reads/workflows.queries.js';
import type { WorkflowAuthoringStoreOptions } from './types.js';

export type WorkflowAuthoringStore = ReturnType<
  typeof createWorkflowAuthoringStore
>;

export function createWorkflowAuthoringStore(
  config: DatabaseConfig,
  options: WorkflowAuthoringStoreOptions,
) {
  const catalogs = authoringCatalogs(options);
  const lease = acquireDatabasePool(config, options.runtime);
  const { pool } = lease;
  const access = createAuthoringAccess(pool);
  const transactScopes = <T>(
    operation: (inWorkspace: WorkspaceScopeRunner) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> =>
    access.tracked(() =>
      withMultiWorkspaceTransaction(
        pool,
        operation,
        signal === undefined ? {} : { signal },
      ),
    );
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    collaboration: createWorkflowCollaborationStore(access),
    promotions: createWorkflowPromotionStore({
      access,
      catalogs,
      transactScopes,
    }),
    publicationReviews: createPublicationReviewStore(access, { catalogs }),
    stepSamples: createWorkflowStepSampleStore(access),
    workflowTests: createWorkflowTestStore(pool, catalogs),
    workflowTestSuites: createWorkflowTestSuiteStore(pool, catalogs),
    autoPause: createWorkflowAutoPauseStore((workspaceId, actorId, operation) =>
      access.tracked(() =>
        withTenantScopedClient(pool, { workspaceId, actorId }, operation),
      ),
    ),
    concurrency: createWorkflowConcurrencyStore(access),
    errorWorkflow: createWorkflowErrorStore(access),
    ...createPreviewRunStore(pool),
    ...createWorkflowPortabilityStore({ access, catalogs }),
    createWorkflow: (input: CreateWorkflowInput) =>
      access.author(input, (client, role) =>
        createWorkflow(client, input, catalogs, role),
      ),
    saveDraft: (input: SaveWorkflowDraftInput) =>
      access.workflow(input, { capability: 'workflow:update' }, (client) =>
        saveDraft(client, input, catalogs),
      ),
    restoreWorkflowVersion: (input: RestoreWorkflowVersionInput) =>
      access.workflow(input, { capability: 'workflow:update' }, (client) =>
        restoreWorkflowVersion(client, input, catalogs),
      ),
    duplicateWorkflow: (input: DuplicateWorkflowInput) =>
      access.workflow(
        input,
        { capability: 'workflow:update', resource: 'workflow:read' },
        (client, scope) => duplicateWorkflow(client, input, catalogs, scope),
      ),
    publishWorkflow: (input: PublishWorkflowInput) =>
      access.workflow(input, { capability: 'workflow:update' }, (client) =>
        publishWorkflow(client, input, catalogs),
      ),
    transitionWorkflowLifecycle: (input: TransitionWorkflowLifecycleInput) =>
      access.workflow(input, { capability: 'workflow:update' }, (client) =>
        transitionWorkflowLifecycle(client, input),
      ),
    renameWorkflow: (input: RenameWorkflowInput) =>
      access.workflow(input, { capability: 'workflow:update' }, (client) =>
        renameWorkflow(client, input),
      ),
    listWorkflows: (input: ListWorkflowsInput) =>
      access.reader(input, (client, scope) =>
        listWorkflows(client, scope, input),
      ),
    getWorkflow: (workspaceId: string, workflowId: string, actorId: string) =>
      access.reader({ workspaceId, actorId }, (client, scope) =>
        readWorkflow(client, scope, { workspaceId, workflowId }),
      ),
    getWorkflowWithTemplateOrigin: (
      workspaceId: string,
      workflowId: string,
      actorId: string,
    ) =>
      access.reader({ workspaceId, actorId }, (client, scope) =>
        readWorkflowWithTemplateOrigin(client, scope, {
          workspaceId,
          workflowId,
        }),
      ),
    getDraft: (workspaceId: string, workflowId: string, actorId: string) =>
      access.reader({ workspaceId, actorId }, (client, scope) =>
        readDraft(
          client,
          scope,
          { workspaceId, workflowId },
          catalogs.definitionCatalog,
        ),
      ),
    validateDraft: (
      workspaceId: string,
      workflowId: string,
      actorId: string,
      { signal }: Readonly<{ signal?: AbortSignal }> = {},
    ) =>
      access.reader({ workspaceId, actorId, signal }, (client, scope) =>
        validateDraft(
          client,
          scope,
          { workspaceId, workflowId, signal },
          catalogs,
        ),
      ),
    getVersion: (
      workspaceId: string,
      workflowId: string,
      versionId: string,
      actorId: string,
    ) =>
      access.reader({ workspaceId, actorId }, (client, scope) =>
        readVersion(client, scope, { workspaceId, workflowId }, versionId),
      ),
    listVersions: (input: ListWorkflowVersionsInput) =>
      access.reader(input, (client, scope) =>
        listVersions(client, scope, input),
      ),
    close: () => {
      closePromise ??= access.drain().then(() => lease.close());
      return closePromise;
    },
  });
}
