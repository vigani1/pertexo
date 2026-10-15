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
  if (left.kind === 'task' && right.kind === 'task')
    return left.taskId === right.taskId;
  if (left.kind === 'call' && right.kind === 'call')
    return left.callId === right.callId;
  if (left.kind === 'reused' && right.kind === 'reused')
    return left.nodeRunId === right.nodeRunId;
  return false;
}
