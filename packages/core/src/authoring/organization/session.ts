import type { PoolClient } from 'pg';

import type { DatabaseConfig } from '@pertexo/database/platform';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import { withTenantScopedClient } from '@pertexo/database/primitives';
import type { OrganizationScope } from './commands.repository.js';

export type OrganizationRequestScope = OrganizationScope &
  Readonly<{ signal?: AbortSignal }>;

/** Tenant transactions for organization reads and commands on a leased pool. */
export function createOrganizationSession(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime);
  return Object.freeze({
    transact<T>(
      input: OrganizationRequestScope,
      work: (client: PoolClient, scope: OrganizationScope) => Promise<T>,
    ): Promise<T> {
      const scope = { workspaceId: input.workspaceId, actorId: input.actorId };
      const { signal } = input;
      return withTenantScopedClient(
        lease.pool,
        scope,
        (client) => work(client, scope),
        signal === undefined ? {} : { signal },
      );
    },
    close: () => lease.close(),
  });
}
