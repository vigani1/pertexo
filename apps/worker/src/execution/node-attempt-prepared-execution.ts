import {
  NodeAttemptOutputInvalidError,
  type NodeAttemptInputs,
  type NodeAttemptLease,
  type NodeAttemptRunStore,
  type PublishedWorkflowV3Projection,
} from '@pertexo/database/execution';
import type { QueueDelivery } from '@pertexo/queue';
import {
  WorkflowEngineError,
  type NodeAttemptOutcome,
} from '@pertexo/workflow-engine';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import { classifyProcessError } from '@pertexo/observability/process-error-classification';

import type {
  NodeAttemptHandlerDependencies,
  NodeAttemptHandlerResult,
  PreparedNodeAttempt,
} from './node-attempt-handler.js';
import type { NodeAttemptHeartbeat } from './node-attempt-heartbeat.js';
import type { NodeExecutionEnvironment } from './node-attempt-execution-environment.js';
import { persistPreparedNodeAttemptOutcome } from './node-attempt-outcome-completion.js';
import { connectionHealthCompletionFields } from './connection-health-completion.js';
import { completionResult } from './node-attempt-completion-result.js';
import { hydrateNativeNodeAttemptInputs } from './native-node-attempt-input-hydration.js';
import { prepareNodeAttemptPhysicalOutput } from './node-attempt-physical-output.js';
import { completeNativeWaitResume } from './node-attempt-native-wait-resume.js';

type AttemptDelivery = Extract<
  QueueDelivery,
  { readonly name: 'execute-node-attempt' }
>;

export async function completeControlOutcome(
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

export async function executePreparedNodeAttempt(
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
  let nativeOutput: Parameters<
    NodeAttemptRunStore['complete']
  >[0]['nativeOutput'];
  let declarationInputRecorded = recordedWorkflowCallInput !== undefined;
  try {
    let executionInputs = inputs;
    if (
      inputs.nativeValueSources !== undefined &&
      recordedWorkflowCallInput === undefined
    ) {
      const values = dependencies.nativeInputValues;
      if (values === undefined)
        throw new TypeError('Native input source hydration is unavailable');
      executionInputs = await hydrateNativeNodeAttemptInputs({
        lease,
        inputs,
        signal: heartbeat.executionSignal,
        hydrate: values.hydrateSource,
        expectedUpstreamNodeOutputs: prepared.upstreamNodeOutputs,
      });
      if (lease.admissionKind === 'wait_resume') {
        return await completeNativeWaitResume({
          dependencies,
          lease,
          value: executionInputs.resumeOutput,
          executionSignal: heartbeat.executionSignal,
          completionSignal: contextSignal,
          traceContext,
          inspectInterruption: () =>
            resolveHeartbeatInterruption(
              dependencies,
              lease,
              delivery,
              contextSignal,
              heartbeat,
              environment,
            ),
        });
      }
    }
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
      ...executionInputs,
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
    nativeOutput = await prepareNodeAttemptPhysicalOutput({
      lease,
      native: inputs.nativeValueSources !== undefined,
      callAlias: prepared.inputPersistence === 'workflow_call_declaration',
      value: outcome.output,
      signal: heartbeat.executionSignal,
      values: dependencies.physicalOutputValues,
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
      error instanceof NodeAttemptOutputInvalidError ||
      (error instanceof WorkflowEngineError && error.code === 'attempt_invalid')
    ) {
      const completed = await dependencies.runStore.complete({
        ...connectionHealthCompletionFields(dependencies, environment),
        lease,
        outcome: {
          status: 'failed',
          safeErrorCode:
            error instanceof NodeAttemptOutputInvalidError
              ? 'execution.output_invalid'
              : 'execution.attempt_invalid',
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
    nativeOutput,
  );
}

export async function resolveHeartbeatInterruption(
  dependencies: NodeAttemptHandlerDependencies,
  lease: NodeAttemptLease,
  delivery: AttemptDelivery,
  contextSignal: AbortSignal,
  heartbeat: NodeAttemptHeartbeat,
  environment?: NodeExecutionEnvironment,
): Promise<NodeAttemptHandlerResult | undefined> {
  const durableAbortReason = heartbeat.durableAbortReason();
  if (durableAbortReason !== undefined)
    return completeControlOutcome(
      dependencies,
      lease,
      durableAbortReason,
      delivery,
      contextSignal,
      hasProviderDispatchUncertainty(
        lease,
        environment?.wasDispatched() ?? false,
      ),
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

export function hasProviderDispatchUncertainty(
  lease: NodeAttemptLease,
  dispatched: boolean,
): boolean {
  return lease.providerDispatchUnresolved === true || dispatched;
}
