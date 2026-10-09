import type { PoolClient } from 'pg';
import { z } from 'zod';

import type { DatabaseConfig } from '../../config.js';
import {
  acquireDatabasePool,
  type DatabaseRuntime,
} from '../../platform/database-runtime.js';
import { withTenantScopedClient } from '../../tenant-access/transactions.js';
import type { OrganizationScope } from './command.js';

export type OrganizationRequestScope = OrganizationScope &
  Readonly<{ signal?: AbortSignal }>;

const uuid = z.uuid().overwrite((value) => value.toLowerCase());
const scopeSchema = z.object({ workspaceId: uuid, actorId: uuid });

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
      const scope = scopeSchema.parse(input);
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
