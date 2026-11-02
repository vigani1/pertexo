import type { FolderScope } from '../../../shared/contract.js';

import type { PoolClient } from 'pg';

import type { WorkflowAuthoringStore } from '../contract.js';

import type { AuthoringCatalogs } from '../catalogs.js';

export type ReadStore = Pick<
  WorkflowAuthoringStore,
  | 'getDraft'
  | 'validateDraft'
  | 'getVersion'
  | 'getWorkflow'
  | 'getWorkflowWithTemplateOrigin'
  | 'listVersions'
  | 'listWorkflows'
>;

export type WorkflowAuthoringReadContext = Readonly<{
  requireReader(
    client: PoolClient,
    workspaceId: string,
    actorId: string,
  ): Promise<FolderScope>;
  catalogs: Pick<
    AuthoringCatalogs,
    'definitionCatalog' | 'validateAuthoringGraph' | 'executableCompiler'
  >;
  transact<T>(
    workspaceId: string,
    actorId: string,
    operation: (client: PoolClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}>;
