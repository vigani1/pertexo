import type { AuthenticationMailDeliveryStore } from '@pertexo/database/execution';

import type { AuthenticationMailDeliveryHandler } from './authentication-mail-delivery.js';

export interface AuthenticationMailRuntime {
  start(): void;
  checkReadiness(): void;
  close(): Promise<void>;
}

export const AUTHENTICATION_MAIL_RUNTIME = Symbol(
  'AUTHENTICATION_MAIL_RUNTIME',
);

export function createAuthenticationMailRuntime(
  handler: AuthenticationMailDeliveryHandler,
  store: AuthenticationMailDeliveryStore,
  pollIntervalMillis: number,
  onFailure: () => void,
): AuthenticationMailRuntime {
  let timer: NodeJS.Timeout | undefined;
  let active: Promise<unknown> | undefined;
  let failed = false;
  const controller = new AbortController();
  const schedule = () => {
    if (controller.signal.aborted) return;
    timer = setTimeout(tick, pollIntervalMillis);
    timer.unref();
  };
  const tick = () => {
    active = handler
      .runOnce(controller.signal)
      .then(() => {
        failed = false;
      })
      .catch(() => {
        failed = true;
        onFailure();
      })
      .finally(() => {
        active = undefined;
        schedule();
      });
  };
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    start: () => {
      if (timer === undefined && active === undefined) schedule();
    },
    checkReadiness: () => {
      if (failed)
        throw new Error('Authentication mail delivery is unavailable');
    },
    close: () => {
      closePromise ??= (async () => {
        controller.abort();
        if (timer !== undefined) clearTimeout(timer);
        await active;
        await store.close();
      })();
      return closePromise;
    },
  });
}
