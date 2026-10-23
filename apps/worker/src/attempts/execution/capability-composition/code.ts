import { retainCodeOutput } from '../../code/output.js';

import { CODE_LIMITS } from '@pertexo/node-sdk';

import type { CapabilityAssembly } from './contract.js';
import { assertCapabilityRuntimeOpen } from './lifecycle.js';

export function prepareCodeCapability(state: CapabilityAssembly): void {
  const codeClient = state.codeClient;
  if (codeClient !== undefined && state.options.codeRunner !== undefined) {
    const settings = state.options.codeRunner.settings;
    state.factories.code = (context) => ({
      execute: async ({ code, language, timeoutSeconds, input, signal }) => {
        assertCapabilityRuntimeOpen(state.lifecycle);
        return retainCodeOutput(
          await codeClient.execute(
            {
              code,
              ...(language === undefined ? {} : { language }),
              timeoutSeconds:
                timeoutSeconds ??
                Math.min(
                  CODE_LIMITS.defaultTimeoutSeconds,
                  settings.maximumSeconds,
                ),
              input,
              variables: context.variables,
            },
            signal,
          ),
        );
      },
    });
  }
}
