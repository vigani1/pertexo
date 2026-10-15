import type { SystemMailDeliveryStore } from '@pertexo/database/platform';

import {
  createPollingRuntime,
  type PollingRuntime,
} from '../runtime/polling.js';
import type { SystemMailDeliveryHandler } from './delivery.js';

export type SystemMailRuntime = PollingRuntime;

export const SYSTEM_MAIL_RUNTIME = Symbol('SYSTEM_MAIL_RUNTIME');

export function createSystemMailRuntime(
  handler: SystemMailDeliveryHandler,
  store: SystemMailDeliveryStore,
  pollIntervalMillis: number,
  onFailure: () => void,
): SystemMailRuntime {
  return createPollingRuntime({
    name: 'Authentication mail',
    pollMillis: pollIntervalMillis,
    cycle: async (signal) => {
      await handler.runOnce(signal);
    },
    cycleFailed: onFailure,
    release: () => store.close(),
  });
}
