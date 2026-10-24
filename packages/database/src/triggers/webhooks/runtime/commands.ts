import type { Pool, PoolClient } from 'pg';

import { canManageWorkflowTrigger } from '../../management.queries.js';

import { WebhookTriggerNotFoundError } from '../errors.js';
import { withTenantScopedClient } from '../../../tenant-access/transactions.js';
import { uuidSchema } from '../input.js';
import type { Command } from './contract.js';

export function command<T>(
  pool: Pool,
  input: Command,
  work: (client: PoolClient) => Promise<T>,
) {
  return withTenantScopedClient(
    pool,
    {
      workspaceId: uuidSchema.parse(input.workspaceId),
      actorId: uuidSchema.parse(input.actorId),
    },
    async (client) => {
      if (await canManageWorkflowTrigger(client, input)) return work(client);
      throw new WebhookTriggerNotFoundError();
    },
  );
}
