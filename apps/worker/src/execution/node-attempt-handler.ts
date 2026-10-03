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
import { WorkflowEngineError } from '@pertexo/workflow-engine';
import type { NodeExecutionRuntime } from '@pertexo/node-sdk/server';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import { classifyProcessError } from '@pertexo/observability/process-error-classification';
import {
  startNodeAttemptHeartbeat,
  type NodeAttemptHeartbeat,
} from './node-attempt-heartbeat.js';
import { recoverNodeAttemptCallInput } from './node-attempt-call-input-recovery.js';
import { persistPreparedNodeAttemptOutcome } from './node-attempt-outcome-completion.js';
import type { NodeExecutionCapabilityFactories } from './node-execution-capabilities.js';
import {
  createNodeExecutionEnvironment,
  type NodeExecutionEnvironment,
} from './node-attempt-execution-environment.js';
export { NodeAttemptHandlerStateError } from './node-attempt-handler-state-error.js';
import { NodeAttemptHandlerStateError } from './node-attempt-handler-state-error.js';
import type { ConnectionRunHealthMode } from '../config/connection-run-health-config.js';
import { connectionHealthCompletionFields } from './connection-health-completion.js';
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
  recordedWorkflowCallInput?: Readonly<{ value: unknown }>,
): Promise<NodeAttemptHandlerResult> {
  const traceContext =
    delivery.data.traceparent === undefined
      ? {}
      : { traceparent: delivery.data.traceparent };
  let outcome: NodeAttemptOutcome;
  let declarationInputRecorded = recordedWorkflowCallInput !== undefined;
  try {
    let pinnedCallableProjection: PublishedWorkflowV3Projection | undefined;
    if (prepared.callPin !== undefined) {
      const pinned = await dependencies.reader.readForExecution({
        workspaceId: lease.workspaceId,
        workflowVersionId: prepared.callPin.versionId,
        signal: heartbeat.executionSignal,
      });
      if (pinned.kind !== 'v3_projection')
        throw new TypeError('Pinned callable executable is unavailable');
      pinnedCallableProjection = pinned.workflowVersion;
    }
    outcome = await prepared.execute({
      ...inputs,
      ...(recordedWorkflowCallInput === undefined
        ? {}
        : { recordedWorkflowCallInput: recordedWorkflowCallInput.value }),
      ...(pinnedCallableProjection === undefined
        ? {}
        : { pinnedCallableProjection }),
      registry: environment.registry,
      runtime: environment.runtime,
      signal: heartbeat.executionSignal,
      onInputResolved: async (resolved) => {
        if (prepared.inputPersistence !== 'workflow_call_declaration') {
          await recordAttemptInput(
            dependencies.runStore,
            lease,
            resolved,
            heartbeat.executionSignal,
          );
          return;
        }
        // Recovery uses the already-authorized snapshot, never a second
        // reservation or a rewrite under the reclaimed creation authority.
        if (recordedWorkflowCallInput !== undefined) return;
        const prepare = dependencies.callDeclarationValues?.prepare;
        const record = dependencies.runStore.recordCallDeclarationInput?.bind(
          dependencies.runStore,
        );
        if (prepare === undefined || record === undefined)
          throw new TypeError('Native Call input persistence is unavailable');
        const value = await prepare({
          owner: { kind: 'attempt', slot: 'call_input', lease },
          value: resolved,
          signal: heartbeat.executionSignal,
        });
        await record({
          lease,
          ...value,
          signal: heartbeat.executionSignal,
        });
        declarationInputRecorded = true;
      },
    });
    if (
      prepared.inputPersistence === 'workflow_call_declaration' &&
      !declarationInputRecorded
    )
      throw new TypeError('Native Call did not persist its declaration input');
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
  return persistPreparedNodeAttemptOutcome(
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
      let recordedWorkflowCallInput: Readonly<{ value: unknown }> | undefined;
      if (prepared.inputPersistence === 'workflow_call_declaration') {
        recordedWorkflowCallInput = await recoverNodeAttemptCallInput({
          lease: claimed.lease,
          signal: context.signal,
          runStore: dependencies.runStore,
          ...(dependencies.callDeclarationValues === undefined
            ? {}
            : { values: dependencies.callDeclarationValues }),
        });
      }
      const inputs = await dependencies.runStore.loadInputs({
        lease: claimed.lease,
        upstreamNodeOutputs:
          recordedWorkflowCallInput === undefined
            ? prepared.upstreamNodeOutputs
            : [],
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
          recordedWorkflowCallInput,
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
