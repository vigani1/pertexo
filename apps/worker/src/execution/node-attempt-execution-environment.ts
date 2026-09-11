import {
  NodeAttemptConnectionFenceError,
  NodeAttemptDispatchBindingMismatchError,
  type NodeAttemptLease,
  type NodeAttemptRunStore,
} from '@pertexo/database/execution';
import type { NodeExecutionRegistry } from '@pertexo/workflow-engine';
import {
  NodeDispatchEvidenceError,
  type NodeExecutionRuntime,
} from '@pertexo/node-sdk/server';
import type { NodeExecutionCapabilityFactories } from './node-execution-capabilities.js';
import { nodeExecutionOptionalFields } from './node-execution-runtime-fields.js';
import { NodeAttemptHandlerStateError } from './node-attempt-handler-state-error.js';

export type NodeExecutionEnvironment = Readonly<{
  registry: NodeExecutionRegistry;
  runtime: NodeExecutionRuntime;
  wasDispatched(): boolean;
}>;

export function createNodeExecutionEnvironment(
  input: Readonly<{
    executionSignal: AbortSignal;
    lease: NodeAttemptLease;
    registry: NodeExecutionRegistry;
    runStore: NodeAttemptRunStore;
    runtimeCapabilities?: NodeExecutionCapabilityFactories;
  }>,
): NodeExecutionEnvironment {
  const { executionSignal, lease, registry: sourceRegistry, runStore } = input;
  let dispatched = false;
  const capabilityContext = Object.freeze({
    workspaceId: lease.workspaceId,
    runId: lease.runId,
    nodeRunId: lease.nodeRunId,
    attemptId: lease.attemptId,
    attemptNumber: lease.attemptNumber,
    nodeId: lease.nodeId,
    invocationKey: lease.invocationKey,
    workerId: lease.workerId,
  });
  const connections =
    input.runtimeCapabilities?.connections?.(capabilityContext);
  const artifacts = input.runtimeCapabilities?.artifacts?.(capabilityContext);
  const runtime: NodeExecutionRuntime = Object.freeze({
    workspaceId: lease.workspaceId,
    runId: lease.runId,
    nodeRunId: lease.nodeRunId,
    attemptId: lease.attemptId,
    attemptNumber: lease.attemptNumber,
    nodeId: lease.nodeId,
    invocationKey: lease.invocationKey,
    sideEffectClass: lease.sideEffectClass,
    ...nodeExecutionOptionalFields(lease, connections, artifacts),
    beforeDispatch: async (
      dispatchInput?: Parameters<NodeExecutionRuntime['beforeDispatch']>[0],
    ): Promise<void> => {
      if (dispatched)
        throw new NodeAttemptHandlerStateError('duplicate_dispatch');
      try {
        await runStore.markDispatched({
          lease,
          ...(dispatchInput?.connectionFence === undefined
            ? {}
            : { connectionFence: dispatchInput.connectionFence }),
          ...(dispatchInput?.providerDispatchBinding === undefined
            ? {}
            : {
                providerDispatchBinding: dispatchInput.providerDispatchBinding,
              }),
          signal: executionSignal,
        });
      } catch (error: unknown) {
        if (error instanceof NodeAttemptConnectionFenceError)
          throw new NodeDispatchEvidenceError(
            'provider_connection_fence_failed',
          );
        if (error instanceof NodeAttemptDispatchBindingMismatchError)
          throw new NodeDispatchEvidenceError(
            'provider_dispatch_binding_mismatch',
          );
        throw error;
      }
      dispatched = true;
    },
  });
  const registry: NodeExecutionRegistry = Object.freeze({
    ...(sourceRegistry.dispatchMode === undefined
      ? {}
      : { dispatchMode: sourceRegistry.dispatchMode }),
    execute: async (
      request: Parameters<NodeExecutionRegistry['execute']>[0],
    ) => {
      const mode = sourceRegistry.dispatchMode?.(request) ?? 'before_execute';
      if (mode === 'before_execute') await runtime.beforeDispatch();
      const result = await sourceRegistry.execute({ ...request, runtime });
      if (mode === 'executor_controlled' && !dispatched)
        throw new NodeAttemptHandlerStateError('dispatch_evidence_missing');
      return result;
    },
  });
  return Object.freeze({ registry, runtime, wasDispatched: () => dispatched });
}
