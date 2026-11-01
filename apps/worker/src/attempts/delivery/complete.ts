import { codeCompletionFields } from '../code/diagnostics.js';

import {
  NodeAttemptOutputInvalidError,
  type NodeAttemptLease,
} from '@pertexo/core/attempts';

import type { NodeAttemptOutcome } from '@pertexo/workflow-engine';

import { classifyProcessError } from '@pertexo/observability/startup';

import type { NodeExecutionEnvironment } from '../execution/environment.js';

import { connectionHealthCompletionFields } from '../../connections/health-completion.js';
import { completionResult } from './completion-result.js';
import type {
  AttemptDelivery,
  PreparedNodeAttempt,
  NodeAttemptHandlerResult,
  NodeAttemptHandlerDependencies,
  NodeAttemptHeartbeat,
} from './contract.js';

export async function completeControlOutcome(
  dependencies: NodeAttemptHandlerDependencies,
  lease: NodeAttemptLease,
  {
    reason,
    delivery,
    signal,
    dispatched,
    environment,
  }: Readonly<{
    reason: 'canceled' | 'timed_out';
    delivery: AttemptDelivery;
    signal: AbortSignal;
    dispatched: boolean;
    environment?: NodeExecutionEnvironment | undefined;
  }>,
): Promise<NodeAttemptHandlerResult> {
  const outcomeUnknown = lease.sideEffectClass !== 'safe' && dispatched;
  const controlError =
    reason === 'canceled'
      ? 'execution.canceled'
      : 'execution.deadline_exceeded';
  const completed = await dependencies.runStore.complete({
    ...connectionHealthCompletionFields(environment),
    ...codeCompletionFields(environment),
    lease,
    outcome: {
      status: outcomeUnknown ? 'outcome_unknown' : reason,
      safeErrorCode: outcomeUnknown
        ? 'execution.outcome_unknown'
        : controlError,
    },
    ...(delivery.data.traceparent === undefined
      ? {}
      : { traceparent: delivery.data.traceparent }),
    signal,
  });
  return completionResult(dependencies, lease, completed.kind);
}

export async function resolveHeartbeatInterruption(
  dependencies: NodeAttemptHandlerDependencies,
  lease: NodeAttemptLease,
  {
    delivery,
    contextSignal,
    heartbeat,
    environment,
  }: Readonly<{
    delivery: AttemptDelivery;
    contextSignal: AbortSignal;
    heartbeat: NodeAttemptHeartbeat;
    environment: NodeExecutionEnvironment;
  }>,
): Promise<NodeAttemptHandlerResult | undefined> {
  const durableAbortReason = heartbeat.durableAbortReason();
  if (durableAbortReason !== undefined)
    return completeControlOutcome(dependencies, lease, {
      reason: durableAbortReason,
      delivery: delivery,
      signal: contextSignal,
      dispatched: hasProviderDispatchUncertainty(lease, {
        dispatched: environment.wasDispatched(),
      }),
      environment: environment,
    });
  const heartbeatFailure = heartbeat.failure();
  if (!heartbeatFailure.failed) return undefined;
  throw classifyProcessError(heartbeatFailure.error) === 'Error'
    ? (heartbeatFailure.error as Error)
    : new Error('Node attempt heartbeat failed', {
        cause: heartbeatFailure.error,
      });
}

export async function persistPreparedOutcome(
  dependencies: NodeAttemptHandlerDependencies,
  lease: NodeAttemptLease,
  {
    prepared,
    outcome,
    traceContext,
    contextSignal,
    environment,
  }: Readonly<{
    prepared: PreparedNodeAttempt;
    outcome: NodeAttemptOutcome;
    traceContext: Readonly<{ traceparent?: string }>;
    contextSignal: AbortSignal;
    environment: NodeExecutionEnvironment;
  }>,
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

export function hasProviderDispatchUncertainty(
  lease: NodeAttemptLease,
  { dispatched }: Readonly<{ dispatched: boolean }>,
): boolean {
  return (lease.providerDispatchUnresolved ?? false) || dispatched;
}
