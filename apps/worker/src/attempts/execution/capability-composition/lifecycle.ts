import type { CapabilityAssembly } from './node-runtime-capabilities.types.js';
import { CapabilitiesClosedError } from './capability-composition.errors.js';

export function assertCapabilityRuntimeOpen(lifecycle: {
  terminal: boolean;
}): void {
  if (lifecycle.terminal)
    throw new CapabilitiesClosedError(
      'Worker node runtime capabilities are closed',
    );
}

export function closeCapabilityResources(
  state: CapabilityAssembly,
): Promise<void> {
  if (state.closePromise === undefined) {
    state.lifecycle.terminal = true;
    state.closePromise = (async (): Promise<void> => {
      state.codeClient?.close();
      state.resources.callbackKeys?.close();
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
        state.resources.providerConnections?.close,
        state.resources.ownedArtifactDatabase?.close.bind(
          state.resources.ownedArtifactDatabase,
        ),
        state.resources.ownedArtifactStore?.close.bind(
          state.resources.ownedArtifactStore,
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
