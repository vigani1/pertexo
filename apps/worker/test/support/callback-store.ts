import type { CallbackStore } from '@pertexo/core/runs';

/** Startup composition tests provide their own store; no configured database is contacted. */
export function emptyCallbackStore(): CallbackStore {
  return {
    keysInUse: async function* () {
      yield* await Promise.resolve([]);
    },
    close: () => Promise.resolve(),
    prepare: () => Promise.reject(new Error('Unexpected callback preparation')),
    resolve: () => Promise.reject(new Error('Unexpected callback lookup')),
    respond: () => Promise.reject(new Error('Unexpected callback response')),
  };
}
