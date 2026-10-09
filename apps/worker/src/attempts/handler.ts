import { canonicalOutboxPayloadChecksum } from '@pertexo/database/outbox';
import {
  NodeAttemptOutputInvalidError,
  type NodeAttemptLease,
  type NodeAttemptRunStore,
} from '@pertexo/database/attempts';
import type {
  PublishedWorkflowReader,
  PublishedWorkflow,
} from '@pertexo/database/runs';
import { loadAttemptInputs, type NodeAttemptInputs } from '@pertexo/execution';
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
import { WorkflowEngineError } from '@pertexo/workflow-engine';
import type { NodeExecutionRuntime } from '@pertexo/node-sdk/server';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import { classifyProcessError } from '@pertexo/observability/startup';
import { waitForCancelableDelay } from '../runtime/abortable-delay.js';
import type { NodeExecutionCapabilityFactories } from './capabilities.js';
import {
  createNodeExecutionEnvironment,
  type NodeExecutionEnvironment,
} from './execution-environment.js';
export { NodeAttemptHandlerStateError } from './handler-state-error.js';
import { NodeAttemptHandlerStateError } from './handler-state-error.js';
import type { ConnectionRunHealthMode } from '../config/connection-health.js';
import { connectionHealthCompletionFields } from '../connections/health-completion.js';
import { completionResult } from './completion-result.js';

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
        onInputResolved?: ExecuteNodeAttemptInput['onInputResolved'];
      }
    >,
  ): Promise<NodeAttemptOutcome>;
}

export interface NodeAttemptExecutionEngine {
  prepare(
    input: Readonly<{
      lease: NodeAttemptLease;
      projection: PublishedWorkflow;
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

async function completeControlOutcome(
  dependencies: NodeAttemptHandlerDependencies,
  lease: NodeAttemptLease,
  reason: 'canceled' | 'timed_out',
  delivery: AttemptDelivery,
  signal: AbortSignal,
  dispatched: boolean,
  environment?: NodeExecutionEnvironment,
): Promise<NodeAttemptHandlerResult> {
  const outcomeUnknown = lease.sideEffectClass !== 'safe' && dispatched;
  const completed = await dependencies.runStore.complete({
    ...connectionHealthCompletionFields(dependencies, environment),
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
        await waitForCancelableDelay(
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

/**
 * Keeps the input the executor receives for the run page (ADR 052). It is
 * diagnostic: a store without it, a lost lease or a failed write records
 * nothing and the attempt carries on unchanged.
 */
async function recordAttemptInput(
  runStore: NodeAttemptRunStore,
  lease: NodeAttemptLease,
  input: unknown,
  signal: AbortSignal,
): Promise<void> {
  try {
    await runStore.recordInput?.({ lease, input, signal });
  } catch {
    // The attempt's outcome never depends on recording its input.
  }
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
  let outcome: NodeAttemptOutcome;
  try {
    outcome = await prepared.execute({
      ...inputs,
      registry: environment.registry,
      runtime: environment.runtime,
      signal: heartbeat.executionSignal,
      onInputResolved: (resolved) =>
        recordAttemptInput(
          dependencies.runStore,
          lease,
          resolved,
          heartbeat.executionSignal,
        ),
    });
  } catch (error: unknown) {
    const interruption = await resolveHeartbeatInterruption(
      dependencies,
      lease,
      delivery,
      contextSignal,
      heartbeat,
      environment,
    );
    if (interruption !== undefined) return interruption;
    if (error instanceof NodeExecutorFailure) {
      const completed = await dependencies.runStore.complete({
        ...connectionHealthCompletionFields(dependencies, environment),
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
        ...connectionHealthCompletionFields(dependencies, environment),
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
  const interruption = await resolveHeartbeatInterruption(
    dependencies,
    lease,
    delivery,
    contextSignal,
    heartbeat,
    environment,
  );
  if (interruption !== undefined) return interruption;
  return persistPreparedOutcome(
    dependencies,
    lease,
    prepared,
    outcome,
    traceContext,
    contextSignal,
    environment,
  );
}

async function resolveHeartbeatInterruption(
  dependencies: NodeAttemptHandlerDependencies,
  lease: NodeAttemptLease,
  delivery: AttemptDelivery,
  contextSignal: AbortSignal,
  heartbeat: NodeAttemptHeartbeat,
  environment: NodeExecutionEnvironment,
): Promise<NodeAttemptHandlerResult | undefined> {
  const durableAbortReason = heartbeat.durableAbortReason();
  if (durableAbortReason !== undefined)
    return completeControlOutcome(
      dependencies,
      lease,
      durableAbortReason,
      delivery,
      contextSignal,
      hasProviderDispatchUncertainty(lease, environment.wasDispatched()),
      environment,
    );
  const heartbeatFailure = heartbeat.failure();
  if (!heartbeatFailure.failed) return undefined;
  throw classifyProcessError(heartbeatFailure.error) === 'Error'
    ? (heartbeatFailure.error as Error)
    : new Error('Node attempt heartbeat failed', {
        cause: heartbeatFailure.error,
      });
}

async function persistPreparedOutcome(
  dependencies: NodeAttemptHandlerDependencies,
  lease: NodeAttemptLease,
  prepared: PreparedNodeAttempt,
  outcome: NodeAttemptOutcome,
  traceContext: Readonly<{ traceparent?: string }>,
  contextSignal: AbortSignal,
  environment: NodeExecutionEnvironment,
): Promise<NodeAttemptHandlerResult> {
  try {
    const completed = await dependencies.runStore.complete({
      ...connectionHealthCompletionFields(dependencies, environment),
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
      ...connectionHealthCompletionFields(dependencies, environment),
      lease,
      outcome: {
        status: 'failed',
        safeErrorCode: 'execution.output_invalid',
      },
      ...traceContext,
      signal: contextSignal,
    });
    return completionResult(dependencies, lease, completed.kind);
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
      if (published === null)
        throw new NodeAttemptHandlerStateError('workflow_not_found');
      if (
        published.id !== claimed.lease.workflowVersionId ||
        published.workspaceId !== delivery.data.workspaceId
      )
        throw new NodeAttemptHandlerStateError('identity_mismatch');
      const prepared = dependencies.engine.prepare({
        lease: claimed.lease,
        projection: published,
      });
      const inputs = await loadAttemptInputs(dependencies.runStore, {
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
      try {
        const environment = createNodeExecutionEnvironment({
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
