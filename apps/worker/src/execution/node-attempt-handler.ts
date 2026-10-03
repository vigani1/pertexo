import {
  canonicalOutboxPayloadChecksum,
  type NodeAttemptInputs,
  type NodeAttemptLease,
  type NodeAttemptRunStore,
  type PublishedWorkflowReader,
  type PublishedWorkflowExecutableProjection,
  type PublishedWorkflowV3Projection,
} from '@pertexo/database/execution';
import type {
  QueueDelivery,
  QueueHandlerContext,
  RunEventNotificationPublisher,
} from '@pertexo/queue';
import type {
  ExecuteNodeAttemptInput,
  NodeAttemptOutcome,
  NodeExecutionRegistry,
} from '@pertexo/workflow-engine';
import type { NodeExecutionRuntime } from '@pertexo/node-sdk/server';
import {
  startNodeAttemptHeartbeat,
  type NodeAttemptHeartbeat,
} from './node-attempt-heartbeat.js';
import { recoverNodeAttemptCallInput } from './node-attempt-call-input-recovery.js';
import { assertNativeNodeAttemptInputProjection } from './native-node-attempt-input-hydration.js';
import type { NodeExecutionCapabilityFactories } from './node-execution-capabilities.js';
import {
  createNodeExecutionEnvironment,
  type NodeExecutionEnvironment,
} from './node-attempt-execution-environment.js';
export { NodeAttemptHandlerStateError } from './node-attempt-handler-state-error.js';
import { NodeAttemptHandlerStateError } from './node-attempt-handler-state-error.js';
import type { ConnectionRunHealthMode } from '../config/connection-run-health-config.js';
import {
  completeControlOutcome,
  executePreparedNodeAttempt,
  resolveHeartbeatInterruption,
  hasProviderDispatchUncertainty,
} from './node-attempt-prepared-execution.js';
import { completionResult } from './node-attempt-completion-result.js';
import type { createWorkflowExecutionValueCodec } from './workflow-execution-value-codec.js';
import type { WorkflowCallPinV1 } from '@pertexo/workflow-model/workflow-call-contract';

type AttemptDelivery = Extract<
  QueueDelivery,
  { readonly name: 'execute-node-attempt' }
>;

export interface PreparedNodeAttempt {
  readonly callPin?: WorkflowCallPinV1;
  readonly inputPersistence?: 'workflow_call_declaration';
  readonly suspensionDurationSeconds?: number;
  readonly upstreamNodeOutputs: readonly Readonly<{
    nodeId: string;
    invocationKey: string;
  }>[];
  execute(
    input: Readonly<
      NodeAttemptInputs & {
        registry: NodeExecutionRegistry;
        runtime?: NodeExecutionRuntime;
        signal: AbortSignal;
        onInputResolved?: ExecuteNodeAttemptInput['onInputResolved'];
        pinnedCallableProjection?: PublishedWorkflowV3Projection;
        recordedWorkflowCallInput?: unknown;
      }
    >,
  ): Promise<NodeAttemptOutcome>;
}

export interface NodeAttemptExecutionEngine {
  prepare(
    input: Readonly<{
      lease: NodeAttemptLease;
      projection: PublishedWorkflowExecutableProjection;
    }>,
  ): PreparedNodeAttempt;
}

export type NodeAttemptHandlerResult = Readonly<{
  kind: 'duplicate' | 'committed';
}>;

export interface NodeAttemptHandler {
  handle(
    delivery: AttemptDelivery,
    context: QueueHandlerContext,
  ): Promise<NodeAttemptHandlerResult>;
}

export type NodeAttemptHandlerDependencies = Readonly<{
  nativeInputValues?: Pick<
    ReturnType<typeof createWorkflowExecutionValueCodec>,
    'hydrateSource'
  >;
  callDeclarationValues?: Pick<
    ReturnType<typeof createWorkflowExecutionValueCodec>,
    'prepare' | 'hydrate'
  >;
  connectionRunHealthMode?: ConnectionRunHealthMode;
  engine: NodeAttemptExecutionEngine;
  heartbeatIntervalMillis: number;
  leaseDurationSeconds: number;
  notifications?: RunEventNotificationPublisher;
  reader: PublishedWorkflowReader;
  registry: NodeExecutionRegistry;
  runStore: NodeAttemptRunStore;
  runtimeCapabilities?: NodeExecutionCapabilityFactories;
  workerId: string;
}>;

export function createNodeAttemptHandler(
  dependencies: NodeAttemptHandlerDependencies,
): NodeAttemptHandler {
  if (
    !Number.isSafeInteger(dependencies.heartbeatIntervalMillis) ||
    dependencies.heartbeatIntervalMillis < 10 ||
    dependencies.heartbeatIntervalMillis >=
      dependencies.leaseDurationSeconds * 1_000
  )
    throw new TypeError(
      'Node attempt heartbeat interval must be positive and shorter than its lease',
    );
  return Object.freeze({
    handle: async (
      delivery: AttemptDelivery,
      context: QueueHandlerContext,
    ): Promise<NodeAttemptHandlerResult> => {
      const claimed = await dependencies.runStore.claimDelivery({
        workspaceId: delivery.data.workspaceId,
        runId: delivery.data.runId,
        nodeRunId: delivery.data.nodeRunId,
        attemptId: delivery.data.attemptId,
        delivery: {
          outboxEventId: delivery.data.outboxEventId,
          payloadChecksum: canonicalOutboxPayloadChecksum(delivery.data),
        },
        leaseDurationSeconds: dependencies.leaseDurationSeconds,
        workerId: dependencies.workerId,
        signal: context.signal,
      });
      if (claimed.kind === 'duplicate')
        return Object.freeze({ kind: 'duplicate' });
      if (claimed.kind === 'control_settled')
        return Object.freeze({
          kind: 'committed',
          outboxEventId: claimed.outboxEventId,
        });
      const published = await dependencies.reader.readForExecution({
        workspaceId: delivery.data.workspaceId,
        workflowVersionId: claimed.lease.workflowVersionId,
        signal: context.signal,
      });
      if (
        published.kind !== 'v2_projection' &&
        published.kind !== 'v3_projection'
      )
        throw new NodeAttemptHandlerStateError(
          published.kind === 'not_found'
            ? 'workflow_not_found'
            : 'workflow_non_executable',
        );
      if (
        published.workflowVersion.id !== claimed.lease.workflowVersionId ||
        published.workflowVersion.workspaceId !== delivery.data.workspaceId
      )
        throw new NodeAttemptHandlerStateError('identity_mismatch');
      const prepared = dependencies.engine.prepare({
        lease: claimed.lease,
        projection: published.workflowVersion,
      });
      let heartbeat: NodeAttemptHeartbeat | undefined;
      let environment: NodeExecutionEnvironment | undefined;
      let executionStarted = false;
      try {
        let recordedWorkflowCallInput: Readonly<{ value: unknown }> | undefined;
        if (
          published.kind === 'v3_projection' ||
          prepared.inputPersistence === 'workflow_call_declaration'
        ) {
          // Existing control-and-lease owner; this does not load or remap inputs.
          const control = await dependencies.runStore.heartbeat({
            lease: claimed.lease,
            leaseDurationSeconds: dependencies.leaseDurationSeconds,
            signal: context.signal,
          });
          if (control.abortRequested) {
            if (control.abortReason === undefined)
              throw new NodeAttemptHandlerStateError('control_reason_missing');
            return await completeControlOutcome(
              dependencies,
              claimed.lease,
              control.abortReason,
              delivery,
              context.signal,
              hasProviderDispatchUncertainty(claimed.lease, false),
            );
          }
          heartbeat = startNodeAttemptHeartbeat(
            dependencies,
            claimed.lease,
            context.signal,
          );
          if (prepared.inputPersistence === 'workflow_call_declaration') {
            recordedWorkflowCallInput = await recoverNodeAttemptCallInput({
              lease: claimed.lease,
              signal: heartbeat.executionSignal,
              runStore: dependencies.runStore,
              ...(dependencies.callDeclarationValues === undefined
                ? {}
                : { values: dependencies.callDeclarationValues }),
            });
          }
        }
        const inputs = await dependencies.runStore.loadInputs({
          lease: claimed.lease,
          upstreamNodeOutputs:
            recordedWorkflowCallInput === undefined
              ? prepared.upstreamNodeOutputs
              : [],
          signal: heartbeat?.executionSignal ?? context.signal,
        });
        if (inputs.abortRequested) {
          if (inputs.abortReason === undefined)
            throw new NodeAttemptHandlerStateError('control_reason_missing');
          return await completeControlOutcome(
            dependencies,
            claimed.lease,
            inputs.abortReason,
            delivery,
            context.signal,
            hasProviderDispatchUncertainty(claimed.lease, false),
          );
        }
        assertNativeNodeAttemptInputProjection({
          inputs,
          nativeExecutable: published.kind === 'v3_projection',
          recoveredCallInput: recordedWorkflowCallInput !== undefined,
        });
        if (
          claimed.lease.admissionKind === 'wait_resume' &&
          inputs.nativeValueSources === undefined
        ) {
          if (inputs.resumeOutput === undefined)
            throw new NodeAttemptHandlerStateError(
              'wait_resume_output_missing',
            );
          const completed = await dependencies.runStore.complete({
            lease: claimed.lease,
            outcome: { status: 'succeeded', output: inputs.resumeOutput },
            ...(delivery.data.traceparent === undefined
              ? {}
              : { traceparent: delivery.data.traceparent }),
            signal: context.signal,
          });
          return await completionResult(
            dependencies,
            claimed.lease,
            completed.kind,
          );
        }
        heartbeat ??= startNodeAttemptHeartbeat(
          dependencies,
          claimed.lease,
          context.signal,
        );
        environment = createNodeExecutionEnvironment({
          executionSignal: heartbeat.executionSignal,
          lease: claimed.lease,
          registry: dependencies.registry,
          runStore: dependencies.runStore,
          connectionRunHealthMode:
            dependencies.connectionRunHealthMode ?? 'off',
          ...(dependencies.runtimeCapabilities === undefined
            ? {}
            : { runtimeCapabilities: dependencies.runtimeCapabilities }),
        });
        executionStarted = true;
        return await executePreparedNodeAttempt(
          dependencies,
          claimed.lease,
          prepared,
          inputs,
          delivery,
          context.signal,
          heartbeat,
          environment,
          recordedWorkflowCallInput,
        );
      } catch (error: unknown) {
        if (!executionStarted && heartbeat !== undefined) {
          const interruption = await resolveHeartbeatInterruption(
            dependencies,
            claimed.lease,
            delivery,
            context.signal,
            heartbeat,
            environment,
          );
          if (interruption !== undefined) return interruption;
        }
        throw error;
      } finally {
        await heartbeat?.stop();
      }
    },
  });
}
