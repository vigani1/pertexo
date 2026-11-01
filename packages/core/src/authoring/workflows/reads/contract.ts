import type { FolderScope } from '../../../tenant-access/resources/contract.js';

import type { PoolClient } from 'pg';

import type { WorkflowAuthoringDatabase } from '../contract.js';

import type { AuthoringCatalogs } from '../catalogs.js';

export type ReadStore = Pick<
  WorkflowAuthoringDatabase,
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
