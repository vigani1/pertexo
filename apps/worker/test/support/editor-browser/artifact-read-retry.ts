import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import type { NodeExecutionCapabilityFactories } from '../../../src/attempts/execution/capabilities.js';

/** A controlled temporary read outage in the real worker, never a production hook. */
export function withArtifactReadOutage(
  factories: NodeExecutionCapabilityFactories,
): NodeExecutionCapabilityFactories {
  const create = factories.artifacts;
  if (create === undefined) throw new Error('Owned file reader missing');
  return {
    ...factories,
    artifacts: (context) => {
      const runtime = create(context);
      const read = runtime.read?.bind(runtime);
      if (read === undefined)
        throw new Error('Owned file read capability missing');
      return {
        ...runtime,
        read: async (input) => {
          if (context.nodeId === 'retry-reader' && context.attemptNumber === 1)
            throw new NodeExecutorFailure({
              kind: 'retry',
              errorKind: 'network',
              possiblyDispatched: false,
            });
          return read(input);
        },
      };
    },
  };
}
