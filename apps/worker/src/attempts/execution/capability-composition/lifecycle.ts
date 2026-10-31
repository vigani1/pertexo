import type { CapabilityAssembly } from './contract.js';

export function assertCapabilityRuntimeOpen(lifecycle: {
  terminal: boolean;
}): void {
  if (lifecycle.terminal)
    throw new Error('Worker node runtime capabilities are closed');
}

export function closeCapabilityResources(
  state: CapabilityAssembly,
): Promise<void> {
  if (state.closePromise === undefined) {
    state.lifecycle.terminal = true;
    state.closePromise = (async (): Promise<void> => {
      state.codeClient?.close();
      state.resources.callbackKeys?.close();
      // A refresh already at the service has to reach the database before it closes.
      await state.resources.oauth2Tokens?.drain();
      const closeOperations = [
        state.resources.ownedDataTables?.close.bind(
          state.resources.ownedDataTables,
        ),
        state.resources.ownedCallbacks?.close.bind(
          state.resources.ownedCallbacks,
        ),
        state.resources.ownedRunValues?.close.bind(
          state.resources.ownedRunValues,
        ),
        state.resources.ownedWebhookResponses?.close.bind(
          state.resources.ownedWebhookResponses,
        ),
        state.resources.ownedConnectionDatabase?.close.bind(
          state.resources.ownedConnectionDatabase,
        ),
        state.resources.ownedArtifactDatabase?.close.bind(
          state.resources.ownedArtifactDatabase,
        ),
        state.resources.encryptionRuntime?.close.bind(
          state.resources.encryptionRuntime,
        ),
        state.resources.ownedArtifactStore?.close.bind(
          state.resources.ownedArtifactStore,
        ),
        state.resources.ownedProviderRateLimiter?.close.bind(
          state.resources.ownedProviderRateLimiter,
        ),
      ].filter((close): close is () => unknown => Boolean(close));
      const results = await Promise.allSettled(
        closeOperations.map((close) => Promise.resolve().then(close)),
      );
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason as unknown] : [],
      );
      if (failures.length > 0)
        throw new AggregateError(
          failures,
          'Worker node runtime capability shutdown failed',
        );
    })();
  }
  return state.closePromise;
}
