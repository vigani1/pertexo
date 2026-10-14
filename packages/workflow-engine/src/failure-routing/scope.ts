import type { BranchSelection, InvocationState } from '../types.js';
import { invocationKey } from '../transition/scheduling/loops.js';

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
