import type { Pool, PoolClient } from 'pg';

import { withTriggerManagement } from '../../management.js';
import { WebhookTriggerNotFoundError } from '../errors.js';
import type { Command } from './contract.js';

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
