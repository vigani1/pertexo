import { createCallbackStore, type CallbackStore } from '@pertexo/core/runs';
import type { DatabaseRuntime } from '@pertexo/database/platform';
import {
  createCallbackTokenKeys,
  verifyCallbackTokenKeys,
  type CallbackTokenKeys,
} from '@pertexo/secrets/server';
import type { ApiConfig } from '../config/api-config.js';

/** How long startup's callback-key check may take. */
const CALLBACK_KEY_CHECK_TIMEOUT_MILLIS = 2 * 60 * 1_000;
export type ApiCallbackRuntime = Readonly<{
  store: CallbackStore;
  keys: CallbackTokenKeys | undefined;
  close(): Promise<void>;
}>;
export async function createApiCallbackRuntime(
  config: Pick<ApiConfig, 'database' | 'callbacks'>,
  runtime?: DatabaseRuntime,
): Promise<ApiCallbackRuntime> {
  const store = createCallbackStore(config.database, runtime);
  let keys: CallbackTokenKeys | undefined;
  let closed: Promise<void> | undefined;
  const close = () => {
    keys?.close();
    return (closed ??= store.close());
  };
  try {
    keys =
      config.callbacks === undefined
        ? undefined
        : createCallbackTokenKeys(config.callbacks);
    const signal = AbortSignal.timeout(CALLBACK_KEY_CHECK_TIMEOUT_MILLIS);
    await verifyCallbackTokenKeys(keys, store.keysInUse(signal), signal);
    return { store, keys, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'Callback startup and cleanup failed.',
      );
    }
    throw error;
  }
}
