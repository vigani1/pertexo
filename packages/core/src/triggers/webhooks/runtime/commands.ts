import type { Pool, PoolClient } from 'pg';

import { withTriggerManagement } from '../../management.js';
import { WebhookTriggerNotFoundError } from '../webhook-trigger.errors.js';
import type { Command } from './webhook-runtime.types.js';

export function command<T>(
  pool: Pool,
  input: Command,
  work: (client: PoolClient) => Promise<T>,
) {
  return withTriggerManagement(
    pool,
    input,
    () => new WebhookTriggerNotFoundError(),
    work,
  );
}
