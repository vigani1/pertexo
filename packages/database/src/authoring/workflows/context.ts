import type { PoolClient } from 'pg';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import type { WorkflowDefinitionCatalog } from '@pertexo/workflow-model/server';

import type { AuthoringCatalogs } from './catalogs.js';

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
    placementCatalog: WorkflowDefinitionCatalog | undefined,
  ): void;
  catalogs: AuthoringCatalogs;
  transact<T>(
    workspaceId: string,
    actorId: string,
    operation: (client: PoolClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}>;
