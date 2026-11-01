import { redactCredentialFields } from '@pertexo/observability';
import {
  ExecutionCapabilityExpiredError,
  RunValuesLimitError,
  type RunValuesStore,
} from '@pertexo/core/runs';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import type { NodeRunValuesRuntime } from '@pertexo/node-sdk';
import type { NodeExecutionCapabilityContext } from './capabilities.js';

export function createRunValuesRuntime(
  store: Pick<RunValuesStore, 'save'>,
  context: NodeExecutionCapabilityContext & Readonly<{ fenceToken: number }>,
  assertOpen: () => void,
): NodeRunValuesRuntime {
  return Object.freeze({
    save: async ({
      values,
      signal,
    }: Parameters<NodeRunValuesRuntime['save']>[0]) => {
      assertOpen();
      signal.throwIfAborted();
      const sanitized = redactCredentialFields(values);
      try {
        return await store.save({ ...context, values: sanitized, signal });
      } catch (error) {
        if (signal.aborted)
          throw new NodeExecutorFailure({
            kind: 'canceled',
            errorKind: 'canceled',
            possiblyDispatched: false,
          });
        if (error instanceof RunValuesLimitError)
          throw new NodeExecutorFailure({
            kind: 'failed',
            errorKind: 'configuration',
            possiblyDispatched: false,
            safeErrorCode: 'run.values_limit',
            errorSummary: error.message,
          });
        if (error instanceof ExecutionCapabilityExpiredError)
          throw new NodeExecutorFailure({
            kind: 'failed',
            errorKind: 'configuration',
            possiblyDispatched: false,
            safeErrorCode: 'run.values_attempt_expired',
            errorSummary:
              'This attempt is no longer current. Run values were not changed.',
          });
        throw new NodeExecutorFailure({
          kind: 'retry',
          errorKind: 'network',
          possiblyDispatched: false,
          safeErrorCode: 'run.values_unavailable',
          errorSummary:
            'Run values could not be saved. Check database availability before retrying.',
        });
      }
    },
  });
}
