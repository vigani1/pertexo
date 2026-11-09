import type { FailureNotificationMailSealer } from './delivery/system-mail.types.js';
import {
  acquireDatabasePool,
  type DatabaseConfig,
  type DatabaseRuntime,
} from '@pertexo/database/platform';
import { recoverFailureNotifications } from './delivery/recovery.repository.js';

import type {
  ClaimDeliveryInput,
  CompleteDeliveryInput,
  FenceDispatchInput,
  LoadDestinationInput,
} from './failure-notification.types.js';
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
  options: Readonly<{
    systemMail?: FailureNotificationMailSealer;
    maintenance?: DatabaseConfig;
  }> = {},
) {
  const lease = acquireDatabasePool(config, runtime, { role: 'worker' });
  const { pool } = lease;
  const maintenance =
    options.maintenance === undefined
      ? undefined
      : acquireDatabasePool(options.maintenance, undefined, {
          role: 'maintenance',
        });
  return Object.freeze({
    claimDelivery: (input: ClaimDeliveryInput) =>
      claimDelivery(pool, input, options.systemMail),
    completeDelivery: (input: CompleteDeliveryInput) =>
      completeDelivery(pool, input),
    loadDestination: (input: LoadDestinationInput) =>
      loadDestination(pool, input),
    fenceDispatch: (input: FenceDispatchInput) => fenceDispatch(pool, input),
    recoverDue: (limit: number, maxAttempts: number, signal?: AbortSignal) =>
      recoverFailureNotifications(
        maintenance?.pool ?? pool,
        limit,
        maxAttempts,
        signal,
      ),
    close: async () => {
      await lease.close();
      await maintenance?.close();
    },
  });
}
