import { callbackWaitConfigSchema } from '@pertexo/workflow-model';
import { CallbackCapacityError, type CallbackStore } from '@pertexo/core/runs';
import {
  callbackTokenHash,
  type CallbackTokenKeys,
} from '@pertexo/integrations/server';
import {
  NodeExecutorFailure,
  type NodeCallbackRuntime,
} from '@pertexo/node-sdk/server';
import type { NodeExecutionCapabilityContext } from '../execution/capabilities.js';
export function createCallbackRuntime(
  store: CallbackStore,
  keys: CallbackTokenKeys,
  context: NodeExecutionCapabilityContext & Readonly<{ fenceToken: number }>,
  assertOpen: () => void,
): NodeCallbackRuntime {
  const sensitive = new Set<string>();
  return {
    sensitiveValues: () => [...sensitive],
    prepare: async ({ targets, signal }) => {
      assertOpen();
      signal.throwIfAborted();
      if (context.previewRunId !== undefined)
        throw new NodeExecutorFailure({
          kind: 'failed',
          errorKind: 'configuration',
          possiblyDispatched: false,
          safeErrorCode: 'execution.configuration',
          errorSummary:
            'Use Test workflow to try a live callback. Single-step previews never issue callback credentials.',
        });
      try {
        const callbacks = await store.prepare({
          ...context,
          targets: targets.map((target) => ({
            nodeId: target.nodeId,
            config: callbackWaitConfigSchema.parse({
              mode: 'callback',
              timeoutSeconds: target.timeoutSeconds,
              authentication: target.authentication,
            }),
          })),
          keyVersion: keys.currentVersion,
          tokenHash: (identity) =>
            callbackTokenHash(
              keys.material(identity, keys.currentVersion).token,
            ),
          signal,
        });
        return Object.fromEntries(
          callbacks.map((callback) => {
            const material = keys.material(callback, callback.keyVersion);
            if (callbackTokenHash(material.token) !== callback.tokenHash)
              throw new Error(
                'Callback key material does not match stored credentials.',
              );
            sensitive.add(material.token);
            if (callback.config.authentication.mode !== 'secret_url')
              sensitive.add(material.secret);
            return [
              callback.nodeId,
              {
                url: material.url,
                ...(callback.config.authentication.mode === 'secret_url'
                  ? {}
                  : { secret: material.secret }),
              },
            ];
          }),
        );
      } catch (error) {
        if (error instanceof NodeExecutorFailure) throw error;
        if (error instanceof CallbackCapacityError)
          throw new NodeExecutorFailure({
            kind: 'failed',
            errorKind: 'configuration',
            possiblyDispatched: false,
            safeErrorCode: 'execution.configuration',
            errorSummary: error.message,
          });
        if (signal.aborted) throw signal.reason;
        throw new NodeExecutorFailure({
          kind: 'retry',
          errorKind: 'network',
          possiblyDispatched: false,
          safeErrorCode: 'execution.network',
          errorSummary:
            'The callback could not be prepared. Check the callback key configuration and database availability.',
        });
      }
    },
  };
}
