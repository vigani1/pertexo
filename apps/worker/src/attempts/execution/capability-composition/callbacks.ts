import { createCallbackStore } from '@pertexo/core/runs';
import { createCallbackTokenKeys } from '@pertexo/integrations/server';
import { createCallbackRuntime } from '../../callbacks/runtime.js';

import type { CapabilityAssembly } from './contract.js';
import { assertCapabilityRuntimeOpen } from './lifecycle.js';

export function prepareCallbackCapability(state: CapabilityAssembly): void {
  if (state.options.callbacks !== undefined) {
    const callbackStore =
      state.dependencies.callbackStore ??
      (state.resources.ownedCallbacks = createCallbackStore(
        state.options.database,
        state.dependencies.databaseRuntime,
      ));
    const keys = (state.resources.callbackKeys = createCallbackTokenKeys(
      state.options.callbacks,
    ));
    state.factories.callbacks = (context) =>
      createCallbackRuntime(callbackStore, keys, context, () => {
        assertCapabilityRuntimeOpen(state.lifecycle);
      });
  }
}
