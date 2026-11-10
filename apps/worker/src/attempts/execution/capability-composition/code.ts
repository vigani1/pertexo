import { retainCodeOutput } from '../../code/retain-code-output.js';

import { CODE_LIMITS } from '@pertexo/node-sdk';

import type { CapabilityAssembly } from './node-runtime-capabilities.types.js';
import { assertCapabilityRuntimeOpen } from './lifecycle.js';

export function prepareCodeCapability(state: CapabilityAssembly): void {
  const codeClient = state.codeClient;
  if (codeClient !== undefined && state.options.codeRunner !== undefined) {
    const settings = state.options.codeRunner.settings;
    state.factories.code = (context) => ({
      execute: async ({ code, language, timeoutSeconds, input, signal }) => {
        assertCapabilityRuntimeOpen(state.lifecycle);
        // Lease recovery must not restart an interrupted Code task inside the
        // same attempt, bypassing both its time limit and retry policy.
        if (context.previouslyDispatched)
          return {
            kind: 'failed',
            code: 'code.interrupted',
            diagnostics: {
              logs: [],
              truncated: false,
              error: {
                message:
                  'Code execution was interrupted before its result was saved. Review this run and rerun it explicitly; the interrupted task was not executed again.',
              },
            },
          };
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
