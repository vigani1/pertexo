import { describeMappingFailure } from '../execution/mapping-diagnostic.js';
import { isStoredDataError } from '@pertexo/core/shared';
import { executorFailureCompletion } from './executor-failure.js';
import { codeCompletionFields } from '../code/diagnostics.js';
import { canonicalOutboxPayloadChecksum } from '@pertexo/core/outbox';
import {
  NodeAttemptStateCorruptError,
  type NodeAttemptLease,
  type NodeAttemptRunStore,
} from '@pertexo/core/attempts';

import { loadAttemptInputs, type NodeAttemptInputs } from '@pertexo/core/runs';
import { NODE_JSON_LIMITS } from '@pertexo/node-sdk';
import type { QueueHandlerContext } from '@pertexo/queue';
import type { NodeAttemptOutcome } from '@pertexo/workflow-engine/server';
import {
  WorkflowEngineError,
  type EngineErrorCode,
} from '@pertexo/workflow-engine/server';

import {
  describeNodeRefusal,
  NodeExecutorFailure,
} from '@pertexo/node-sdk/server';

import {
  createNodeExecutionEnvironment,
  type NodeExecutionEnvironment,
} from '../execution/environment.js';
import { NodeAttemptHandlerStateError } from './handler-state-error.js';
import { connectionHealthCompletionFields } from '../../connections/health-completion.js';
import { completionResult } from './completion-result.js';
import type {
  AttemptDelivery,
  PreparedNodeAttempt,
  NodeAttemptHandlerResult,
  NodeAttemptHandler,
  NodeAttemptHandlerDependencies,
  NodeAttemptHeartbeat,
} from './node-attempt-delivery.types.js';
import { completingThroughOutage } from './complete-through-outage.js';
import { startNodeAttemptHeartbeat } from './heartbeat.js';
import {
  completeControlOutcome,
  resolveHeartbeatInterruption,
  persistPreparedOutcome,
  hasProviderDispatchUncertainty,
} from './complete.js';
export { NodeAttemptHandlerStateError } from './handler-state-error.js';
export {
  type PreparedNodeAttempt,
  type NodeAttemptExecutionEngine,
  type NodeAttemptHandlerResult,
  type NodeAttemptHandler,
  type NodeAttemptHandlerDependencies,
} from './node-attempt-delivery.types.js';

// The step's input or setup can't work; each code becomes `execution.<code>`.
const STEP_REFUSAL_CODES: ReadonlySet<EngineErrorCode> = new Set([
  'attempt_invalid',
  'variable_missing',
  'expression_failed',
  'expression_limit_exceeded',
]);
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
    await runStore.recordInput({ lease, input, signal });
  } catch {
    // The attempt's outcome never depends on recording its input.
  }
}

async function executePreparedNodeAttempt(
  dependencies: NodeAttemptHandlerDependencies,
  lease: NodeAttemptLease,
  {
    prepared,
    inputs,
    delivery,
    contextSignal,
    heartbeat,
    environment,
  }: Readonly<{
    prepared: PreparedNodeAttempt;
    inputs: NodeAttemptInputs;
    delivery: AttemptDelivery;
    contextSignal: AbortSignal;
    heartbeat: NodeAttemptHeartbeat;
    environment: NodeExecutionEnvironment;
  }>,
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
    const dispatchAbortReason = environment.dispatchAbortReason();
    if (dispatchAbortReason !== undefined)
      return completeControlOutcome(dependencies, lease, {
        reason: dispatchAbortReason,
        delivery,
        signal: contextSignal,
        dispatched: hasProviderDispatchUncertainty(lease, {
          dispatched: false,
        }),
        environment,
      });
    const interruption = await resolveHeartbeatInterruption(
      dependencies,
      lease,
      {
        delivery: delivery,
        contextSignal: contextSignal,
        heartbeat: heartbeat,
        environment: environment,
      },
    );
    if (interruption !== undefined) return interruption;
    if (error instanceof NodeExecutorFailure) {
      const completed = await dependencies.runStore.complete({
        ...connectionHealthCompletionFields(environment),
        ...codeCompletionFields(environment),
        lease,
        outcome: executorFailureCompletion(error),
        ...traceContext,
        signal: contextSignal,
      });
      return await completionResult(dependencies, lease, completed.kind);
    }
    if (
      error instanceof WorkflowEngineError &&
      STEP_REFUSAL_CODES.has(error.code)
    ) {
      // The step's input or setup can't work: a definite failure of the step
      // itself, so the coordinator decides it like any other and its failure
      // link can take it.
      const reason =
        describeMappingFailure(error) ?? describeNodeRefusal(error.cause);
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
  // A returned success is evidence of what happened; completion still fences the lease.
  return persistPreparedOutcome(dependencies, lease, {
    prepared: prepared,
    outcome: outcome,
    traceContext: traceContext,
    contextSignal: contextSignal,
    environment: environment,
  });
}

export function createNodeAttemptHandler(
  input: NodeAttemptHandlerDependencies,
): NodeAttemptHandler {
  const dependencies = {
    ...input,
    runStore: completingThroughOutage(
      input.runStore,
      input.leaseDurationSeconds,
    ),
  };
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
      try {
        return await handleClaimedAttempt(
          dependencies,
          claimed.lease,
          delivery,
          context,
        );
      } catch (error: unknown) {
        if (error instanceof NodeAttemptHandlerStateError)
          throw new NodeAttemptHandlerStateError(error.code, claimed.lease, {
            cause: error,
          });
        if (
          error instanceof NodeAttemptStateCorruptError ||
          isStoredDataError(error)
        )
          throw new NodeAttemptHandlerStateError(
            'stored_state_invalid',
            claimed.lease,
            { cause: error },
          );
        throw error;
      }
    },
  });
}

/** A claimed lease owns preparation, execution and heartbeat cleanup. */
async function handleClaimedAttempt(
  dependencies: NodeAttemptHandlerDependencies,
  lease: NodeAttemptLease,
  delivery: AttemptDelivery,
  context: QueueHandlerContext,
): Promise<NodeAttemptHandlerResult> {
  const published = await dependencies.reader.readForExecution({
    workspaceId: delivery.data.workspaceId,
    workflowVersionId: lease.workflowVersionId,
    nodeId: lease.nodeId,
    signal: context.signal,
  });
  if (published === null)
    throw new NodeAttemptHandlerStateError('workflow_not_found');
  const prepared = dependencies.engine.prepare({
    lease: lease,
    projection: published,
  });
  const inputs = await loadAttemptInputs(
    dependencies.runStore,
    {
      lease: lease,
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
  if (inputs.control.kind === 'abort') {
    return completeControlOutcome(dependencies, lease, {
      reason: inputs.control.reason,
      delivery: delivery,
      signal: context.signal,
      dispatched: hasProviderDispatchUncertainty(lease, {
        dispatched: false,
      }),
    });
  }
  if (inputs.loopResultsTooLarge) {
    // The step's input can't be built: a definite failure of the step,
    // which its failure link can take.
    const completed = await dependencies.runStore.complete({
      lease: lease,
      outcome: {
        status: 'executor_failure',
        failureKind: 'failed',
        errorKind: 'configuration',
        possiblyDispatched: false,
        safeErrorCode: 'execution.loop_results_too_large',
      },
      signal: context.signal,
    });
    return completionResult(dependencies, lease, completed.kind);
  }
  if (prepared.testPinRequired) {
    const completed = await dependencies.runStore.complete({
      lease: lease,
      outcome: { status: 'failed', safeErrorCode: 'test.pin_required' },
      signal: context.signal,
    });
    return completionResult(dependencies, lease, completed.kind);
  }
  if (lease.admissionKind === 'wait_resume') {
    if (inputs.resumeOutput === undefined)
      throw new NodeAttemptHandlerStateError('wait_resume_output_missing');
    const completed = await dependencies.runStore.complete({
      lease: lease,
      outcome: { status: 'succeeded', output: inputs.resumeOutput },
      ...(delivery.data.traceparent === undefined
        ? {}
        : { traceparent: delivery.data.traceparent }),
      signal: context.signal,
    });
    return completionResult(dependencies, lease, completed.kind);
  }
  const heartbeat = startNodeAttemptHeartbeat(
    dependencies,
    lease,
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
      lease: lease,
      registry: dependencies.registry,
      runStore: dependencies.runStore,
      ...(dependencies.runtimeCapabilities === undefined ||
      (prepared.testSubstitution ?? false)
        ? {}
        : { runtimeCapabilities: dependencies.runtimeCapabilities }),
    });
    return await executePreparedNodeAttempt(dependencies, lease, {
      prepared: prepared,
      inputs: inputs,
      delivery: delivery,
      contextSignal: context.signal,
      heartbeat: heartbeat,
      environment: environment,
    });
  } finally {
    await heartbeat.stop();
  }
}
