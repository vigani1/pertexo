import {
  createGovernanceStore,
  type GovernanceStore,
} from '@pertexo/database/governance';
import {
  createDataTablesStore,
  type DataTablesStore,
} from '@pertexo/database/data-tables';
import {
  createWorkspaceVariablesStore,
  type WorkspaceVariablesStore,
} from '@pertexo/database/variables';
import {
  createWorkflowInputCaseDatabase,
  createWorkflowTagDatabase,
  createWorkflowFavoriteDatabase,
  createWorkflowOrganizationReadDatabase,
  createWorkflowFolderDatabase,
  createWorkflowOrganizationBatchDatabase,
  type WorkflowInputCaseDatabase,
} from '@pertexo/database/authoring';
import type {
  DatabaseConfig,
  DatabaseRuntime,
} from '@pertexo/database/platform';
import type { WorkflowAuthoringDependencies } from '../../workflow-authoring/index.js';
import type { ApiWorkflowRuntimeOverrides } from './runtime.module.js';

export type ApiWorkflowMetadataRuntime = Readonly<{
  inputCases?: WorkflowInputCaseDatabase;
  variables: WorkspaceVariablesStore;
  dataTables: DataTablesStore;
  governance: GovernanceStore;
  organization: WorkflowAuthoringDependencies['organization'];
  close(): Promise<void>;
}>;

/** One lifecycle owner for non-executable authoring metadata. */
export async function createApiWorkflowMetadataRuntime(
  config: DatabaseConfig,
  authoring: NonNullable<ApiWorkflowRuntimeOverrides['authoring']>,
  runtime?: DatabaseRuntime,
): Promise<ApiWorkflowMetadataRuntime> {
  const resources: Readonly<{ close(): Promise<void> }>[] = [];
  let closePromise: Promise<void> | undefined;
  function close(): Promise<void> {
    closePromise ??= (async () => {
      const results = await Promise.allSettled(
        resources.map((resource) =>
          Promise.resolve().then(() => resource.close()),
        ),
      );
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason as unknown] : [],
      );
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, 'Workflow metadata shutdown failed');
    })();
    return closePromise;
  }
  try {
    const lease = runtime === undefined ? {} : { runtime };
    // Preserve the existing explicitly opted-in test adapter policy.
    const inputCases =
      authoring.inputCasePersistence ??
      ((authoring.database !== undefined ||
        authoring.databaseFactory !== undefined) &&
      authoring.inputCasePersistenceFactory === undefined
        ? undefined
        : (
            authoring.inputCasePersistenceFactory ??
            createWorkflowInputCaseDatabase
          )(config, lease));
    if (inputCases !== undefined) resources.push(inputCases);
    const governance = createGovernanceStore(config, runtime);
    resources.push(governance);
    const dataTables = createDataTablesStore(config, runtime);
    resources.push(dataTables);
    const variables = createWorkspaceVariablesStore(config, runtime);
    resources.push(variables);
    const tags = createWorkflowTagDatabase(config, lease);
    resources.push(tags);
    const favorites = createWorkflowFavoriteDatabase(config, lease);
    resources.push(favorites);
    const reader = createWorkflowOrganizationReadDatabase(config, lease);
    resources.push(reader);
    const folders = createWorkflowFolderDatabase(config, lease);
    resources.push(folders);
    const batches = createWorkflowOrganizationBatchDatabase(config, lease);
    resources.push(batches);
    return Object.freeze({
      variables,
      dataTables,
      governance,
      ...(inputCases === undefined ? {} : { inputCases }),
      organization: Object.freeze({
        tags,
        favorites,
        reader,
        folders,
        batches,
      }),
      close,
    });
  } catch (error: unknown) {
    try {
      await close();
    } catch (cleanupError: unknown) {
      throw new AggregateError(
        [error, cleanupError],
        'Workflow metadata construction and cleanup failed',
      );
    }
    throw error;
  }
}
