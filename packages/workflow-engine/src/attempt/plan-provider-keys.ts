import type { WorkflowExecutableNodeV2 } from '../executable-workflow.js';
import type { WorkflowTransitionPlan } from '../types.js';
import { providerIdempotencyKey } from './retries.js';

/** Preserve the established provider identity on both physical admission plans. */
export function withPlanProviderKeys(
  plan: WorkflowTransitionPlan,
  nodesById: ReadonlyMap<string, WorkflowExecutableNodeV2>,
  runId: string,
): WorkflowTransitionPlan {
  const providerKey = (
    nodeId: string,
    invocationKey: string,
  ): string | undefined => {
    const node = nodesById.get(nodeId);
    if (node?.sideEffectClass !== 'idempotent_with_key') return undefined;
    return providerIdempotencyKey({
      invocationKey,
      namespace: 'pertexo.node-attempt',
      operationIdentity: `${node.definition.key}@${String(node.definition.version)}`,
      runId,
    });
  };
  return Object.freeze({
    ...plan,
    attempts: plan.attempts.map((attempt) => {
      const key = providerKey(attempt.nodeId, attempt.invocationKey);
      return Object.freeze({
        ...attempt,
        ...(key === undefined ? {} : { providerIdempotencyKey: key }),
      });
    }),
    nodeRunAdmissions: plan.nodeRunAdmissions.map((admission) => {
      const key = providerKey(admission.nodeId, admission.invocationKey);
      return Object.freeze({
        ...admission,
        ...(key === undefined ? {} : { providerIdempotencyKey: key }),
      });
    }),
  });
}
