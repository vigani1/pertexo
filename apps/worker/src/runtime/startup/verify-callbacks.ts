import { createCallbackStore } from '@pertexo/core/runs';
import {
  createCallbackTokenKeys,
  verifyCallbackTokenKeys,
  type CallbackTokenKeys,
} from '@pertexo/secrets/server';
import type { WorkerConfig } from '../../config/worker.js';
import { STARTUP_VERIFICATION_TIMEOUT_MILLIS } from '../background-task-deadline.js';
export async function verifyWorkerCallbacks(
  config: Pick<WorkerConfig, 'database' | 'callbacks'>,
  createStore: typeof createCallbackStore = createCallbackStore,
): Promise<void> {
  const store = createStore(config.database);
  let keys: CallbackTokenKeys | undefined;
  try {
    keys =
      config.callbacks === undefined
        ? undefined
        : createCallbackTokenKeys(config.callbacks);
    const signal = AbortSignal.timeout(STARTUP_VERIFICATION_TIMEOUT_MILLIS);
    await verifyCallbackTokenKeys(keys, store.keysInUse(signal), signal);
  } catch (error) {
    keys?.close();
    try {
      await store.close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        'Callback startup verification and cleanup failed.',
      );
    }
    throw error;
  }
  keys?.close();
  await store.close();
}
