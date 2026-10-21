import { codeCompletionFields } from '../code/diagnostics.js';
import { canonicalOutboxPayloadChecksum } from '@pertexo/database/outbox';
import {
  NodeAttemptOutputInvalidError,
  type NodeAttemptLease,
  type NodeAttemptRunStore,
} from '@pertexo/database/attempts';
import type {
  WorkflowExecutionReader,
  WorkflowExecutionProjection,
} from '@pertexo/database/runs';
import {
  loadAttemptInputs,
  type ForEachUpstream,
  type NodeAttemptInputs,
} from '@pertexo/execution';
import { NODE_JSON_LIMITS } from '@pertexo/node-sdk';
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
import {
  describeNodeRefusal,
  NodeExecutorFailure,
} from '@pertexo/node-sdk/server';
import { classifyProcessError } from '@pertexo/observability/startup';
import { waitForCancelableDelay } from '../../runtime/abortable-delay.js';
import type { NodeExecutionCapabilityFactories } from '../execution/capabilities.js';
import {
  createNodeExecutionEnvironment,
  type NodeExecutionEnvironment,
} from '../execution/execution-environment.js';
export { NodeAttemptHandlerStateError } from './handler-state-error.js';
import { NodeAttemptHandlerStateError } from './handler-state-error.js';
import { connectionHealthCompletionFields } from '../../connections/health-completion.js';
import { completionResult } from './completion-result.js';

type AttemptDelivery = Extract<
  QueueDelivery,
  { readonly name: 'execute-node-attempt' }
>;

export interface PreparedNodeAttempt {
  readonly sourceFailure?: Readonly<{ nodeId: string; invocationKey: string }>;
  readonly suspensionDurationSeconds?: number;
  readonly testSubstitution?: boolean;
  readonly testPinRequired?: boolean;
  readonly upstreamNodeOutputs: readonly Readonly<{
    nodeId: string;
    invocationKey: string;
  }>[];
  /** The upstream For Each steps whose results the attempt receives. */
  readonly forEachUpstreams?: readonly ForEachUpstream[];
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
      projection: WorkflowExecutionProjection;
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
  reader: WorkflowExecutionReader;
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
    ...connectionHealthCompletionFields(environment),
    ...codeCompletionFields(environment),
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
        ...connectionHealthCompletionFields(environment),
        ...codeCompletionFields(environment),
        lease,
        outcome: {
          status: 'executor_failure',
          failureKind: error.kind,
          ...(error.minimumRetryDelayMillis === undefined
            ? {}
            : { minimumRetryDelayMillis: error.minimumRetryDelayMillis }),
          errorKind: error.errorKind,
          possiblyDispatched: error.possiblyDispatched,
          safeErrorCode: error.safeErrorCode ?? `execution.${error.errorKind}`,
          ...(error.errorSummary === undefined
            ? {}
            : { errorSummary: error.errorSummary }),
        },
        ...traceContext,
        signal: contextSignal,
      });
      return await completionResult(dependencies, lease, completed.kind);
    }
    if (
      error instanceof WorkflowEngineError &&
      (error.code === 'attempt_invalid' || error.code === 'variable_missing')
    ) {
      // The step's input or setup can't work: a definite failure of the step
      // itself, so the coordinator decides it like any other and its failure
      // link can take it.
      const reason = describeNodeRefusal(error.cause);
      const completed = await dependencies.runStore.complete({
        ...connectionHealthCompletionFields(environment),
        ...codeCompletionFields(environment),
        lease,
        outcome: {
          status: 'executor_failure',
          failureKind: 'failed',
          errorKind: 'configuration',
          possiblyDispatched: false,
          safeErrorCode: `execution.${error.code}`,
          ...(reason === undefined ? {} : { errorSummary: reason }),
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
      ...connectionHealthCompletionFields(environment),
      ...codeCompletionFields(environment),
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
      ...connectionHealthCompletionFields(environment),
      ...codeCompletionFields(environment),
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
        nodeId: claimed.lease.nodeId,
        signal: context.signal,
      });
      if (published === null)
        throw new NodeAttemptHandlerStateError('workflow_not_found');
      const prepared = dependencies.engine.prepare({
        lease: claimed.lease,
        projection: published,
      });
      const inputs = await loadAttemptInputs(
        dependencies.runStore,
        {
          lease: claimed.lease,
          upstreamNodeOutputs: prepared.upstreamNodeOutputs,
          ...(prepared.sourceFailure === undefined
            ? {}
            : { sourceFailure: prepared.sourceFailure }),
          signal: context.signal,
        },
        {
          loops: prepared.forEachUpstreams ?? [],
          maxBytes: NODE_JSON_LIMITS.bytes,
        },
      );
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
      if (inputs.loopResultsTooLarge === true) {
        // The step's input can't be built: a definite failure of the step,
        // which its failure link can take.
        const completed = await dependencies.runStore.complete({
          lease: claimed.lease,
          outcome: {
            status: 'executor_failure',
            failureKind: 'failed',
            errorKind: 'configuration',
            possiblyDispatched: false,
            safeErrorCode: 'execution.loop_results_too_large',
          },
          signal: context.signal,
        });
        return completionResult(dependencies, claimed.lease, completed.kind);
      }
      if (prepared.testPinRequired === true) {
        const completed = await dependencies.runStore.complete({
          lease: claimed.lease,
          outcome: { status: 'failed', safeErrorCode: 'test.pin_required' },
          signal: context.signal,
        });
        return completionResult(dependencies, claimed.lease, completed.kind);
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
          variables: inputs.variables ?? {},
          ...(inputs.deadlineAt === undefined
            ? {}
            : { deadlineAt: inputs.deadlineAt }),
          test: published.test !== undefined,
          ...(published.testExpiresAt === undefined
            ? {}
            : { artifactRetentionDeadline: published.testExpiresAt }),
          lease: claimed.lease,
          registry: dependencies.registry,
          runStore: dependencies.runStore,
          ...(dependencies.runtimeCapabilities === undefined ||
          prepared.testSubstitution === true
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
