import type {
  BranchScopePart,
  IterationScopePart,
} from '../workflow-execution.js';
import { invocationKey } from '../transition/scheduling/loops.js';

/** A control's selected branch starts after that control's own invocation. */
export function upstreamInvocationKey(
  input: Readonly<{
    workflowVersionId: string;
    sourceNodeId: string;
    targetNodeId: string;
    edges: readonly Readonly<{
      source: Readonly<{ nodeId: string; port: string }>;
      target: Readonly<{ nodeId: string; port: string }>;
    }>[];
    branchPath: readonly BranchScopePart[];
    iterationPath: readonly IterationScopePart[];
  }>,
): string {
  const sourceBranch = input.branchPath.findIndex(
    (part) =>
      part.nodeId === input.sourceNodeId &&
      input.edges.some(
        (edge) =>
          edge.source.nodeId === input.sourceNodeId &&
          edge.target.nodeId === input.targetNodeId &&
          edge.source.port === part.outputPort,
      ),
  );
  const branchPath =
    sourceBranch === -1
      ? input.branchPath
      : input.branchPath.slice(0, sourceBranch);
  return invocationKey({
    workflowVersionId: input.workflowVersionId,
    nodeId: input.sourceNodeId,
    branchPath: branchPath.map((part) => `${part.nodeId}:${part.outputPort}`),
    iterationPath: input.iterationPath,
  });
}
