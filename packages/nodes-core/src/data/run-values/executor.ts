import {
  NodeExecutorFailure,
  type NodeExecutionInvocation,
  type NodeExecutorRegistration,
} from '@pertexo/node-sdk/server';
import type { RunValues } from '@pertexo/node-sdk';
import { CORE_RUN_VALUES_DEFINITION } from './definition.js';
export const coreRunValuesExecutor: NodeExecutorRegistration = Object.freeze({
  executor: CORE_RUN_VALUES_DEFINITION,
  execute: async ({
    input,
    runtime,
    signal,
  }: NodeExecutionInvocation<unknown, unknown>) => {
    const store = runtime?.runValues;
    if (store === undefined)
      throw new NodeExecutorFailure({
        kind: 'failed',
        errorKind: 'configuration',
        possiblyDispatched: false,
        safeErrorCode: 'run.values_unavailable',
        errorSummary: 'Run values require a recorded run or preview.',
      });
    signal.throwIfAborted();
    const values = await store.save({
      values: (input as { values: RunValues }).values,
      signal,
    });
    signal.throwIfAborted();
    return { values };
  },
});
