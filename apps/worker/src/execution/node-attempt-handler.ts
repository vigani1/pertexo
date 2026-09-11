import {
  canonicalOutboxPayloadChecksum,
  NodeAttemptOutputInvalidError,
  type NodeAttemptInputs,
  type NodeAttemptLease,
  type NodeAttemptRunStore,
  type PublishedWorkflowReader,
  type PublishedWorkflowV2Projection,
} from '@pertexo/database/execution';
import type {
  QueueDelivery,
  QueueHandlerContext,
  RunEventNotificationPublisher,
} from '@pertexo/queue';
import type {
  NodeAttemptOutcome,
  NodeExecutionRegistry,
} from '@pertexo/workflow-engine';
import { WorkflowEngineError } from '@pertexo/workflow-engine';
import type { NodeExecutionRuntime } from '@pertexo/node-sdk/server';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import { waitForAbortableDelay } from '../runtime/abortable-delay.js';
import type { NodeExecutionCapabilityFactories } from './node-execution-capabilities.js';
import {
  createNodeExecutionEnvironment,
  type NodeExecutionEnvironment,
} from './node-attempt-execution-environment.js';
export { NodeAttemptHandlerStateError } from './node-attempt-handler-state-error.js';
import { NodeAttemptHandlerStateError } from './node-attempt-handler-state-error.js';

type AttemptDelivery = Extract<
  QueueDelivery,
  { readonly name: 'execute-node-attempt' }
>;

export interface PreparedNodeAttempt {
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
      }
    >,
  ): Promise<NodeAttemptOutcome>;
}

export interface NodeAttemptExecutionEngine {
  prepare(
    input: Readonly<{
      lease: NodeAttemptLease;
      projection: PublishedWorkflowV2Projection;
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

async function completeControlOutcome(
  dependencies: NodeAttemptHandlerDependencies,
  lease: NodeAttemptLease,
  reason: 'canceled' | 'timed_out',
  delivery: AttemptDelivery,
  signal: AbortSignal,
  dispatched: boolean,
): Promise<NodeAttemptHandlerResult> {
  const outcomeUnknown = lease.sideEffectClass !== 'safe' && dispatched;
  const completed = await dependencies.runStore.complete({
    lease,
    outcome: {
      status: outcomeUnknown ? 'outcome_unknown' : reason,
      safeErrorCode: outcomeUnknown
        ? 'execution.outcome_unknown'
        : reason === 'canceled'
          ? 'execution.canceled'
          : 'execution.deadline_exceeded',
    },
    ...(delivery.data.traceparent === undefined
      ? {}
      : { traceparent: delivery.data.traceparent }),
    signal,
  });
  return completionResult(dependencies, lease, completed.kind);
}

async function completionResult(
  dependencies: NodeAttemptHandlerDependencies,
  lease: NodeAttemptLease,
  kind: 'committed' | 'duplicate',
): Promise<NodeAttemptHandlerResult> {
  if (kind === 'committed' && dependencies.notifications !== undefined) {
    try {
      await dependencies.notifications.resync({
        workspaceId: lease.workspaceId,
        runId: lease.runId,
      });
    } catch {
      // PostgreSQL is authoritative; a later hint or reconnect backfills.
    }
  }
  return Object.freeze({ kind });
}

type HeartbeatFailure =
  Readonly<{ failed: false }> | Readonly<{ error: unknown; failed: true }>;

type NodeAttemptHeartbeat = Readonly<{
  executionSignal: AbortSignal;
  durableAbortReason(): 'canceled' | 'timed_out' | undefined;
  failure(): HeartbeatFailure;
  stop(): Promise<void>;
}>;

function startNodeAttemptHeartbeat(
  dependencies: NodeAttemptHandlerDependencies,
  lease: NodeAttemptLease,
  contextSignal: AbortSignal,
): NodeAttemptHeartbeat {
  const executionAbort = new AbortController();
  const heartbeatStop = new AbortController();
  const heartbeatSignal = AbortSignal.any([
    contextSignal,
    heartbeatStop.signal,
  ]);
  const executionSignal = AbortSignal.any([
    contextSignal,
    executionAbort.signal,
  ]);
  let abortReason: 'canceled' | 'timed_out' | undefined;
  let heartbeatFailure: HeartbeatFailure = Object.freeze({ failed: false });
  const heartbeat = (async (): Promise<void> => {
    try {
      while (!heartbeatSignal.aborted) {
        await waitForAbortableDelay(
          dependencies.heartbeatIntervalMillis,
          heartbeatSignal,
        );
        const result = await dependencies.runStore.heartbeat({
          lease,
          leaseDurationSeconds: dependencies.leaseDurationSeconds,
          signal: heartbeatSignal,
        });
        if (result.abortRequested) {
          if (result.abortReason === undefined)
            throw new NodeAttemptHandlerStateError('control_reason_missing');
          abortReason = result.abortReason;
          executionAbort.abort();
          return;
        }
      }
    } catch (error: unknown) {
      if (!heartbeatStop.signal.aborted && !contextSignal.aborted) {
        heartbeatFailure = Object.freeze({ error, failed: true });
        executionAbort.abort();
      }
    }
  })();
  return Object.freeze({
    executionSignal,
    durableAbortReason: () => abortReason,
    failure: () => heartbeatFailure,
    stop: async (): Promise<void> => {
      heartbeatStop.abort();
      await heartbeat;
    },
  });
}

async function executePreparedNodeAttempt(
  dependencies: NodeAttemptHandlerDependencies,
  lease: NodeAttemptLease,
  prepared: PreparedNodeAttempt,
  inputs: NodeAttemptInputs,
  delivery: AttemptDelivery,
  contextSignal: AbortSignal,
  heartbeat: NodeAttemptHeartbeat,
  environment: NodeExecutionEnvironment,
): Promise<NodeAttemptHandlerResult> {
  const traceContext =
    delivery.data.traceparent === undefined
      ? {}
      : { traceparent: delivery.data.traceparent };
  try {
    const outcome = await prepared.execute({
      ...inputs,
      registry: environment.registry,
      runtime: environment.runtime,
      signal: heartbeat.executionSignal,
    });
    try {
      const completed = await dependencies.runStore.complete({
        lease,
        outcome:
          prepared.suspensionDurationSeconds === undefined
            ? { status: 'succeeded', output: outcome.output }
            : {
                status: 'suspended',
                output: outcome.output,
                durationSeconds: prepared.suspensionDurationSeconds,
              },
        ...traceContext,
        signal: contextSignal,
      });
      return await completionResult(dependencies, lease, completed.kind);
    } catch (error: unknown) {
      if (!(error instanceof NodeAttemptOutputInvalidError)) throw error;
      const completed = await dependencies.runStore.complete({
        lease,
        outcome: {
          status: 'failed',
          safeErrorCode: 'execution.output_invalid',
        },
        ...traceContext,
        signal: contextSignal,
      });
      return await completionResult(dependencies, lease, completed.kind);
    }
  } catch (error: unknown) {
    const durableAbortReason = heartbeat.durableAbortReason();
    if (durableAbortReason !== undefined)
      return await completeControlOutcome(
        dependencies,
        lease,
        durableAbortReason,
        delivery,
        contextSignal,
        hasProviderDispatchUncertainty(lease, environment.wasDispatched()),
      );
    const heartbeatFailure = heartbeat.failure();
    if (heartbeatFailure.failed)
      throw heartbeatFailure.error instanceof Error
        ? heartbeatFailure.error
        : new Error('Node attempt heartbeat failed');
    if (error instanceof NodeExecutorFailure) {
      const completed = await dependencies.runStore.complete({
        lease,
        outcome: {
          status: 'executor_failure',
          failureKind: error.kind,
          errorKind: error.errorKind,
          possiblyDispatched: error.possiblyDispatched,
          safeErrorCode: `execution.${error.errorKind}`,
        },
        ...traceContext,
        signal: contextSignal,
      });
      return await completionResult(dependencies, lease, completed.kind);
    }
    if (
      error instanceof WorkflowEngineError &&
      error.code === 'attempt_invalid'
    ) {
      const completed = await dependencies.runStore.complete({
        lease,
        outcome: {
          status: 'failed',
          safeErrorCode: 'execution.attempt_invalid',
        },
        ...traceContext,
        signal: contextSignal,
      });
      return await completionResult(dependencies, lease, completed.kind);
    }
    throw error;
  }
}

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
      const published = await dependencies.reader.readForExecution({
        workspaceId: delivery.data.workspaceId,
        workflowVersionId: claimed.lease.workflowVersionId,
        signal: context.signal,
      });
      if (published.kind !== 'v2_projection')
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
      const inputs = await dependencies.runStore.loadInputs({
        lease: claimed.lease,
        upstreamNodeOutputs: prepared.upstreamNodeOutputs,
        signal: context.signal,
      });
      if (inputs.abortRequested) {
        if (inputs.abortReason === undefined)
          throw new NodeAttemptHandlerStateError('control_reason_missing');
        return completeControlOutcome(
          dependencies,
          claimed.lease,
          inputs.abortReason,
          delivery,
          context.signal,
          hasProviderDispatchUncertainty(claimed.lease, false),
        );
      }
      if (claimed.lease.admissionKind === 'wait_resume') {
        if (inputs.resumeOutput === undefined)
          throw new NodeAttemptHandlerStateError('wait_resume_output_missing');
        const completed = await dependencies.runStore.complete({
          lease: claimed.lease,
          outcome: { status: 'succeeded', output: inputs.resumeOutput },
          ...(delivery.data.traceparent === undefined
            ? {}
            : { traceparent: delivery.data.traceparent }),
          signal: context.signal,
        });
        return completionResult(dependencies, claimed.lease, completed.kind);
      }
      const heartbeat = startNodeAttemptHeartbeat(
        dependencies,
        claimed.lease,
        context.signal,
      );
      const environment = createNodeExecutionEnvironment({
        executionSignal: heartbeat.executionSignal,
        lease: claimed.lease,
        registry: dependencies.registry,
        runStore: dependencies.runStore,
        ...(dependencies.runtimeCapabilities === undefined
          ? {}
          : { runtimeCapabilities: dependencies.runtimeCapabilities }),
      });
      try {
        return await executePreparedNodeAttempt(
          dependencies,
          claimed.lease,
          prepared,
          inputs,
          delivery,
          context.signal,
          heartbeat,
          environment,
        );
      } finally {
        await heartbeat.stop();
      }
    },
  });
}

function hasProviderDispatchUncertainty(
  lease: NodeAttemptLease,
  dispatched: boolean,
): boolean {
  return lease.providerDispatchUnresolved === true || dispatched;
}
