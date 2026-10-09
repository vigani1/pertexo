import {
  NodeAttemptConnectionFenceError,
  NodeAttemptDispatchBindingMismatchError,
  type NodeAttemptLease,
  type NodeAttemptRunStore,
} from '@pertexo/database/attempts';
import type { NodeExecutionRegistry } from '@pertexo/workflow-engine';
import {
  NodeDispatchEvidenceError,
  type NodeExecutionRuntime,
  type NodeConnectionHealthObservation,
} from '@pertexo/node-sdk/server';
import type { NodeExecutionCapabilityFactories } from './capabilities.js';
import { nodeExecutionOptionalFields } from './runtime-fields.js';
import { NodeAttemptHandlerStateError } from './handler-state-error.js';
import { createConnectionHealthCapture } from '../connections/health-capture.js';
import type { ConnectionRunHealthMode } from '../config/connection-health.js';

export type NodeExecutionEnvironment = Readonly<{
  registry: NodeExecutionRegistry;
  runtime: NodeExecutionRuntime;
  wasDispatched(): boolean;
  connectionHealthObservation(): NodeConnectionHealthObservation | undefined;
}>;

export function createNodeExecutionEnvironment(
  input: Readonly<{
    executionSignal: AbortSignal;
    lease: NodeAttemptLease;
    registry: NodeExecutionRegistry;
    runStore: NodeAttemptRunStore;
    runtimeCapabilities?: NodeExecutionCapabilityFactories;
    connectionRunHealthMode?: ConnectionRunHealthMode;
  }>,
): NodeExecutionEnvironment {
  const { executionSignal, lease, registry: sourceRegistry, runStore } = input;
  let dispatchState: 'not_started' | 'marking' | 'marked' = 'not_started';
  const healthCapture = createConnectionHealthCapture(
    (input.connectionRunHealthMode ?? 'off') !== 'off',
    () => dispatchState === 'marked',
  );
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
    observeConnectionHealth: healthCapture.observe,
    beforeDispatch: async (
      dispatchInput?: Parameters<NodeExecutionRuntime['beforeDispatch']>[0],
    ): Promise<void> => {
      if (dispatchState !== 'not_started')
        throw new NodeAttemptHandlerStateError('duplicate_dispatch');
      // Reserve the sole dispatch permission before any asynchronous work. A
      // failed marker is uncertain and must not reopen the provider-I/O gate.
      dispatchState = 'marking';
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
      dispatchState = 'marked';
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
      if (mode === 'executor_controlled' && dispatchState !== 'marked')
        throw new NodeAttemptHandlerStateError('dispatch_evidence_missing');
      return result;
    },
  });
  return Object.freeze({
    registry,
    runtime,
    wasDispatched: () => dispatchState === 'marked',
    connectionHealthObservation: healthCapture.read,
  });
}
