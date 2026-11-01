import {
  acquireDatabasePool,
  withPlatformTransaction,
  type DatabaseConfig,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';

import type {
  ClaimDeliveryInput,
  CompleteDeliveryInput,
  FenceDispatchInput,
  LoadDestinationInput,
} from './contract.js';
import { claimDelivery } from './delivery/claim.repository.js';
import { completeDelivery } from './delivery/completion.repository.js';
import {
  fenceDispatch,
  loadDestination,
} from './delivery/destination.repository.js';

export type FailureNotificationStore = ReturnType<
  typeof createFailureNotificationStore
>;

export function createFailureNotificationStore(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime, { role: 'worker' });
  const { pool } = lease;
  return Object.freeze({
    claimDelivery: (input: ClaimDeliveryInput) => claimDelivery(pool, input),
    completeDelivery: (input: CompleteDeliveryInput) =>
      completeDelivery(pool, input),
    loadDestination: (input: LoadDestinationInput) =>
      loadDestination(pool, input),
    fenceDispatch: (input: FenceDispatchInput) => fenceDispatch(pool, input),
    recoverDue: (limit: number, maxAttempts: number, signal?: AbortSignal) =>
      withPlatformTransaction(
        pool,
        async (client) => {
          const result = await drizzle(client).execute<{ recovered: number }>(
            sql`select app.recover_due_run_failure_notifications(${limit},${maxAttempts}) as recovered`,
          );
          return result.rows[0]?.recovered ?? 0;
        },
        signal === undefined ? {} : { signal },
      ),
    close: () => lease.close(),
  });
}
