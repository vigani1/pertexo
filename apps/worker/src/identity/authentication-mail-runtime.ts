import type { AuthenticationMailDeliveryStore } from '@pertexo/database/identity';

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
    active = Promise.resolve()
      .then(() => handler.runOnce(controller.signal))
      .then(() => {
        failed = false;
      })
      .catch(() => {
        failed = true;
        try {
          onFailure();
        } catch {
          // Diagnostics cannot change delivery recovery or shutdown ownership.
        }
      })
      .finally(() => {
        active = undefined;
        schedule();
      });
    // The timer owns this task even when no shutdown caller is awaiting it.
    void active.catch(() => undefined);
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
        const failures: unknown[] = [];
        try {
          await active;
        } catch (error: unknown) {
          failures.push(error);
        }
        try {
          await store.close();
        } catch (error: unknown) {
          failures.push(error);
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1)
          throw new AggregateError(
            failures,
            'Authentication mail shutdown failed',
          );
      })();
      return closePromise;
    },
  });
}
