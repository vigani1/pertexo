import type { NodeExecutionRuntime } from '@pertexo/node-sdk/server';
export function executionRuntime(
  overrides: Partial<NodeExecutionRuntime> = {},
): NodeExecutionRuntime {
  return {
    workspaceId: 'workspace',
    runId: 'run',
    nodeRunId: 'node-run',
    attemptId: 'attempt',
    attemptNumber: 1,
    nodeId: 'node',
    invocationKey: 'invocation',
    sideEffectClass: 'safe',
    beforeDispatch: () => Promise.resolve(),
    ...overrides,
  };
}
