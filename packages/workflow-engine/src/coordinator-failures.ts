import type { PolicyReference } from '@pertexo/node-sdk';

import type { WorkflowExecutableNodeV2 } from './executable-workflow.js';
import { operationError } from './operation-values.js';
import type { AttemptFailureObservation } from './persisted-observations.js';
import { decideRetry, resolveRetryPolicy } from './retries.js';
import type { WorkflowObservation } from './types.js';

interface FailureInvocation {
  readonly attemptNumber: number;
  readonly nodeId: string;
  readonly status: string;
}

export function resolveAttemptFailures(
  input: Readonly<{
    runId: string;
    failures: readonly AttemptFailureObservation[];
    invocations: ReadonlyMap<string, FailureInvocation>;
    nodes: ReadonlyMap<string, WorkflowExecutableNodeV2>;
    retryPolicyReference: PolicyReference;
    controlCanceled: boolean;
    controlDeadline: boolean;
  }>,
): readonly WorkflowObservation[] {
  let retryPolicy: ReturnType<typeof resolveRetryPolicy>;
  try {
    retryPolicy = resolveRetryPolicy(input.retryPolicyReference);
  } catch {
    operationError('workflow_identity_invalid', 'retry policy is unsupported');
  }
  return input.failures.map((failure) => {
    const invocation = input.invocations.get(failure.invocationKey);
    const node = input.nodes.get(invocation?.nodeId ?? '');
    if (
      invocation?.status !== 'running' ||
      invocation.attemptNumber !== failure.attemptNumber ||
      node === undefined
    )
      operationError('observation_invalid', 'attempt failure is stale');
    const nonSafeUnknown =
      node.sideEffectClass !== 'safe' && failure.possiblyDispatched;
    if (input.controlCanceled || input.controlDeadline) {
      return {
        kind: 'outcome',
        invocationKey: failure.invocationKey,
        status: nonSafeUnknown
          ? 'outcome_unknown'
          : input.controlCanceled
            ? 'canceled'
            : 'timed_out',
        reasonCode: failure.safeErrorCode,
        coordinatorDerived: true,
      };
    }
    if (failure.failureKind === 'outcome_unknown') {
      return {
        kind: 'outcome',
        invocationKey: failure.invocationKey,
        status: 'outcome_unknown',
        reasonCode: failure.safeErrorCode,
        coordinatorDerived: true,
      };
    }
    if (failure.failureKind === 'canceled') {
      return {
        kind: 'outcome',
        invocationKey: failure.invocationKey,
        status: nonSafeUnknown ? 'outcome_unknown' : 'canceled',
        reasonCode: failure.safeErrorCode,
        coordinatorDerived: true,
      };
    }
    const decision = decideRetry({
      sideEffectClass: node.sideEffectClass,
      currentAttemptNumber: failure.attemptNumber,
      policy: retryPolicy,
      observation: {
        kind: 'executor_failure',
        recommendation: failure.failureKind,
        errorKind: failure.errorKind,
        possiblyDispatched: failure.possiblyDispatched,
      },
      jitterIdentity: `${input.runId}\u0000${failure.invocationKey}\u0000${String(failure.attemptNumber)}\u0000${input.retryPolicyReference.key}@${String(input.retryPolicyReference.version)}`,
    });
    if (decision.kind === 'retry') {
      return {
        kind: 'wait',
        invocationKey: failure.invocationKey,
        resumeAt: new Date(
          Date.parse(failure.occurredAt) + decision.delayMs,
        ).toISOString(),
        waitKind: 'retry_backoff',
        coordinatorDerived: true,
      };
    }
    return {
      kind: 'outcome',
      invocationKey: failure.invocationKey,
      status:
        decision.kind === 'outcome_unknown' ? 'outcome_unknown' : 'failed',
      reasonCode: failure.safeErrorCode,
      coordinatorDerived: true,
    };
  });
}
