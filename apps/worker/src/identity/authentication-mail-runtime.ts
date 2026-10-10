import type { AuthenticationMailDeliveryStore } from '@pertexo/database/tenant-access';

import {
  createPollingRuntime,
  type PollingRuntime,
} from '../runtime/polling.js';
import type { AuthenticationMailDeliveryHandler } from './authentication-mail-delivery.js';

export type AuthenticationMailRuntime = PollingRuntime;

export const AUTHENTICATION_MAIL_RUNTIME = Symbol(
  'AUTHENTICATION_MAIL_RUNTIME',
);

export function createAuthenticationMailRuntime(
  handler: AuthenticationMailDeliveryHandler,
  store: AuthenticationMailDeliveryStore,
  pollIntervalMillis: number,
  onFailure: () => void,
): AuthenticationMailRuntime {
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
