import type { createPlatformNodeRegistry } from '@pertexo/node-catalog/server';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';

export function createScriptedRecoveryRegistry(
  input: Readonly<{
    registry: ReturnType<typeof createPlatformNodeRegistry>;
    executed: { runId: string; nodeId: string }[];
  }>,
): ReturnType<typeof createPlatformNodeRegistry> {
  const { registry, executed } = input;
  let fail = true;
  let httpFailure = true;
  let unknownHttpFailure = true;
  return {
    dispatchMode: registry.dispatchMode,
    execute: async (request) => {
      if (request.runtime === undefined)
        throw new Error('Missing real execution scope');
      if (request.definition.key === 'http.request') {
        await request.runtime.beforeDispatch();
        if (request.runtime.nodeId === 'unknown-http' && unknownHttpFailure) {
          unknownHttpFailure = false;
          throw new NodeExecutorFailure({
            kind: 'outcome_unknown',
            errorKind: 'network',
            possiblyDispatched: true,
          });
        }
        if (httpFailure) {
          httpFailure = false;
          throw new NodeExecutorFailure({
            kind: 'failed',
            errorKind: 'authentication',
            possiblyDispatched: true,
          });
        }
        return {
          kind: 'succeeded',
          output: {
            status: 200,
            headers: {},
            body: {
              kind: 'inline',
              encoding: 'utf8',
              value: '{}',
              byteLength: 2,
            },
            finalOrigin: 'https://example.test',
            redirectCount: 0,
          },
        };
      }
      executed.push({
        runId: request.runtime.runId,
        nodeId: request.runtime.nodeId,
      });
      if (request.runtime.nodeId === 'target' && fail) {
        fail = false;
        throw new NodeExecutorFailure({
          kind: 'failed',
          errorKind: 'configuration',
          possiblyDispatched: false,
        });
      }
      return registry.execute(request);
    },
  };
}
