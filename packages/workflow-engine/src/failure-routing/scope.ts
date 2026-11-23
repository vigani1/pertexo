import { WorkflowEngineError } from '../workflow-engine.errors.js';
import type {
  BranchSelection,
  InvocationState,
} from '../workflow-execution.js';
import { invocationKey } from '../invocations/invocation-identity.js';

/** A handler inherits an executed choice, never an unselected sibling scope. */
export function isSelectedFailureScope(
  source: InvocationState,
  workflowVersionId: string,
  invocations: ReadonlyMap<string, InvocationState>,
  selections: readonly BranchSelection[],
): boolean {
  if ((source.iterationPath?.length ?? 0) !== 0) return false;
  return (source.branchPath ?? []).every((part, index) => {
    const parentKey = invocationKey({
      workflowVersionId,
      nodeId: part.nodeId,
      branchPath: (source.branchPath ?? [])
        .slice(0, index)
        .map(({ nodeId, outputPort }) => `${nodeId}:${outputPort}`),
      iterationPath: [],
    });
    const parent = invocations.get(parentKey);
    return (
      parent?.status === 'succeeded' &&
      parent.output !== undefined &&
      selections.some(
        (selection) =>
          selection.invocationKey === parentKey &&
          selection.nodeId === part.nodeId &&
          selection.selectedOutputPort === part.outputPort,
      )
    );
  });
}

export function isCompletedFailureHandler(
  source: InvocationState,
  handlerNodeIds: readonly string[],
  workflowVersionId: string,
  invocations: ReadonlyMap<string, InvocationState>,
): boolean {
  const branchPath = (source.branchPath ?? []).map(
    ({ nodeId, outputPort }) => `${nodeId}:${outputPort}`,
  );
  return handlerNodeIds.every(
    (nodeId) =>
      invocations.get(
        invocationKey({
          workflowVersionId,
          nodeId,
          branchPath,
          iterationPath: source.iterationPath ?? [],
        }),
      )?.status === 'succeeded',
  );
}

/** An Agent child owns the attempt, while its parent owns the graph edge. */
export function routedFailuresByGraphInvocation(
  invocations: Iterable<InvocationState>,
): ReadonlyMap<string, NonNullable<InvocationState['failureHandling']>> {
  const failures = new Map<
    string,
    NonNullable<InvocationState['failureHandling']>
  >();
  for (const invocation of invocations) {
    if (invocation.failureHandling === undefined) continue;
    const key =
      invocation.agentWork?.parentInvocationKey ?? invocation.invocationKey;
    if (failures.has(key))
      throw new WorkflowEngineError(
        'checkpoint_invalid',
        'graph invocation has multiple routed failures',
      );
    failures.set(key, invocation.failureHandling);
  }
  return failures;
}

export function graphInvocationsWithRoutedFailures(
  invocations: readonly InvocationState[],
): readonly InvocationState[] {
  const failures = routedFailuresByGraphInvocation(invocations);
  return invocations.flatMap((invocation) => {
    if (invocation.agentWork !== undefined) return [];
    const failureHandling = failures.get(invocation.invocationKey);
    return [
      failureHandling === undefined
        ? invocation
        : { ...invocation, failureHandling },
    ];
  });
}
