import type { BranchScopePart, IterationScopePart } from './types.js';

export function sameIterationPath(
  left: readonly IterationScopePart[] | undefined,
  right: readonly IterationScopePart[] | undefined,
): boolean {
  const leftPath = left ?? [];
  const rightPath = right ?? [];
  return (
    leftPath.length === rightPath.length &&
    leftPath.every(
      (part, index) =>
        part.loopNodeId === rightPath.at(index)?.loopNodeId &&
        part.ordinal === rightPath.at(index)?.ordinal,
    )
  );
}

export function sameBranchPath(
  left: readonly BranchScopePart[] | undefined,
  right: readonly BranchScopePart[] | undefined,
): boolean {
  return branchPathHasPrefix(left, right) && branchPathHasPrefix(right, left);
}

export function branchPathHasPrefix(
  path: readonly BranchScopePart[] | undefined,
  prefix: readonly BranchScopePart[] | undefined,
): boolean {
  const candidate = path ?? [];
  const expected = prefix ?? [];
  return (
    candidate.length >= expected.length &&
    expected.every(
      (part, index) =>
        part.nodeId === candidate.at(index)?.nodeId &&
        part.outputPort === candidate.at(index)?.outputPort,
    )
  );
}
