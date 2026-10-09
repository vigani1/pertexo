import type { PoolClient } from 'pg';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import type { WorkflowDefinitionCatalogV1 } from '@pertexo/workflow-model/server';

import type {
  PortableCatalog,
  WorkflowAuthoringGraphValidator,
  WorkflowAuthoringTestHooks,
} from './workflow-authoring-types.js';

/** Variable transaction, authority and compatibility seams shared by writes. */
export type WorkflowAuthoringWriteContext = Readonly<{
  requireAuthor(
    client: PoolClient,
    workspaceId: string,
    actorId: string,
  ): Promise<void>;
  requirePlaceable(
    previous: WorkflowGraph,
    next: WorkflowGraph,
    placementCatalog: WorkflowDefinitionCatalogV1 | undefined,
  ): void;
  selectCatalogs(client: Pick<PoolClient, 'query'>): Promise<
    Readonly<{
      definitionCatalog: WorkflowDefinitionCatalogV1;
      placementDefinitionCatalog: WorkflowDefinitionCatalogV1 | undefined;
      portableCatalog: PortableCatalog | undefined;
      validateAuthoringGraph: WorkflowAuthoringGraphValidator | undefined;
    }>
  >;
  testHooks?: WorkflowAuthoringTestHooks;
  transact<T>(
    workspaceId: string,
    actorId: string,
    operation: (client: PoolClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}>;
