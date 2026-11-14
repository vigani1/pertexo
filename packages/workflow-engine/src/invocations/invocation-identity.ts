import { WorkflowEngineError } from '../workflow-engine.errors.js';
import { WORKFLOW_GRAPH_CONTRACT_LIMITS } from '@pertexo/workflow-model';

const ITERATION_MARKER = '|i:';
/** Loop ordinals in sort keys are zero-padded to this width, so text order is numeric order. */
export const ORDINAL_SORT_KEY_WIDTH = 16;

export function invocationKey(input: {
  readonly workflowVersionId: string;
  readonly nodeId: string;
  readonly branchPath?: readonly string[];
  readonly iterationPath?: readonly {
    readonly loopNodeId: string;
    readonly ordinal: number;
  }[];
}): string {
  const branches = (input.branchPath ?? []).join('/');
  const iterations = (input.iterationPath ?? [])
    .map(({ loopNodeId, ordinal }) => `${loopNodeId}:${String(ordinal)}`)
    .join('/');
  const key = `${encodeURIComponent(input.workflowVersionId)}|${encodeURIComponent(input.nodeId)}|b:${encodeURIComponent(branches)}|i:${encodeURIComponent(iterations)}`;
  if (key.length > WORKFLOW_GRAPH_CONTRACT_LIMITS.invocationKeyLength)
    throw new WorkflowEngineError(
      'workflow_identity_invalid',
      `Step "${input.nodeId}" exceeds the ${String(WORKFLOW_GRAPH_CONTRACT_LIMITS.invocationKeyLength)}-character execution identity limit. Shorten step IDs or reduce branch and loop nesting.`,
    );
  return key;
}

/**
 * The For Each pass a body step's invocation ran in, when it ran directly in
 * the loop `loopNodeId` inside `iterationPath`; undefined for any other key.
 */
export function loopIterationOrdinal(
  key: string,
  loopNodeId: string,
  iterationPath: readonly {
    readonly loopNodeId: string;
    readonly ordinal: number;
  }[] = [],
): number | undefined {
  const marker = key.lastIndexOf(ITERATION_MARKER);
  if (marker === -1) return undefined;
  const iterations = key.slice(marker + ITERATION_MARKER.length);
  const prefix = encodeURIComponent(
    [
      ...iterationPath.map(
        ({ loopNodeId: enclosing, ordinal }) =>
          `${enclosing}:${String(ordinal)}`,
      ),
      `${loopNodeId}:`,
    ].join('/'),
  );
  if (!iterations.startsWith(prefix)) return undefined;
  const ordinal = iterations.slice(prefix.length);
  return /^(?:0|[1-9]\d{0,8})$/u.test(ordinal) ? Number(ordinal) : undefined;
}
