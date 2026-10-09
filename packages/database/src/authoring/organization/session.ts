import type { PoolClient } from 'pg';
import type { DatabaseConfig } from '../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/database-runtime.js';
import { withTenantScopedClient } from '../../tenant-access/workspace.js';

type Scope = Readonly<{
  workspaceId: string;
  actorId: string;
  signal?: AbortSignal;
}>;

/** Owns the tenant transaction and pool lease, not command identity or results. */
export function createOrganizationDatabaseSession(
  config: DatabaseConfig,
  runtime: DatabaseRuntime | undefined,
  parseScope: (input: Scope) => Scope,
  failure: (error: unknown) => never,
) {
  const lease = acquireDatabasePool(config, runtime);
  async function transact<T>(
    input: Scope,
    work: (client: PoolClient, scope: Scope) => Promise<T>,
  ): Promise<T> {
    const scope = parseScope(input);
    try {
      return await withTenantScopedClient(
        lease.pool,
        scope,
        (client) => work(client, scope),
        scope.signal === undefined ? {} : { signal: scope.signal },
      );
    } catch (error: unknown) {
      return failure(error);
    }
  }
  return { transact, close: lease.close };
}
