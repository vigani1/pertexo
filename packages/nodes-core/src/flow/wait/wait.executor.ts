import { CALLBACK_ERROR_CODE } from '@pertexo/node-sdk/server';
import type { CallbackWaitConfig } from '@pertexo/workflow-model';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import type {
  NodeExecutionInvocation,
  NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';

import { CORE_WAIT_EXECUTOR } from './wait.definition.js';

export const coreWaitExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_WAIT_EXECUTOR,
  execute: async (invocation: NodeExecutionInvocation<unknown, unknown>) => {
    if ((invocation.config as { mode?: string }).mode !== 'callback')
      return invocation.input;
    const runtime = invocation.runtime;
    if (runtime?.callbacks === undefined)
      throw new NodeExecutorFailure({
        kind: 'failed',
        errorKind: 'configuration',
        possiblyDispatched: false,
        safeErrorCode: CALLBACK_ERROR_CODE.configuration,
        errorSummary:
          'Callback waits are unavailable. Configure callback keys before running this workflow.',
      });
    const config = invocation.config as CallbackWaitConfig;
    await runtime.callbacks.prepare({
      targets: [
        {
          nodeId: runtime.nodeId,
          timeoutSeconds: config.timeoutSeconds,
          authentication: config.authentication,
        },
      ],
      signal: invocation.signal,
    });
    return { pending: true };
  },
});
