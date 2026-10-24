import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import type { databaseSchema } from '../../schema.js';

export type WorkspaceId = string & { readonly __brand: 'WorkspaceId' };

export type WorkspaceDrizzle = NodePgDatabase<typeof databaseSchema>;

export type WorkspaceTransaction = Readonly<{
  db: WorkspaceDrizzle;
  workspaceId: WorkspaceId;
}>;

export type WorkspaceTransactionOptions = Readonly<{
  signal?: AbortSignal;
  statementTimeoutMillis?: number;
}>;

export type TenantTransactionScope = Readonly<{
  workspaceId: string;
  actorId?: string;
}>;

type ActorTransactionScope = Readonly<{
  actorId: string;
  workspaceId?: undefined;
  discoveryScope: 'workspace_memberships';
}>;

export type TransactionScope = TenantTransactionScope | ActorTransactionScope;

export type WorkspaceScopeRunner = <Result>(
  scope: TenantTransactionScope,
  operation: (client: PoolClient) => Promise<Result>,
) => Promise<Result>;
