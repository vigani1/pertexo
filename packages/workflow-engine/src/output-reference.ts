import type { OutputReference } from './types.js';

export function sameOutputReference(
  left: OutputReference | undefined,
  right: OutputReference | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.kind === 'inline' && right.kind === 'inline')
    return left.attemptId === right.attemptId;
  if (left.kind === 'artifact' && right.kind === 'artifact')
    return left.artifactId === right.artifactId;
  if (left.kind === 'workflow_call' && right.kind === 'workflow_call')
    return (
      left.invocationKey === right.invocationKey &&
      left.childRunId === right.childRunId
    );
  return false;
}
