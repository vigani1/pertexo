import type { Pool, PoolClient } from 'pg';

import { canManageWorkflowTrigger } from '../../management.queries.js';

import { withTenantScopedClient } from '@pertexo/database/primitives';
import { WebhookTriggerNotFoundError } from '../errors.js';
import type { Command } from './contract.js';

export function command<T>(
  pool: Pool,
  input: Command,
  work: (client: PoolClient) => Promise<T>,
) {
  return withTenantScopedClient(
    pool,
    {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
    },
    async (client) => {
      if (await canManageWorkflowTrigger(client, input)) return work(client);
      throw new WebhookTriggerNotFoundError();
    },
  );
}
