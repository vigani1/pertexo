import './server-only.js';

/** Retained V2 checkpoint key bytes; distinct from graph SHA256 identities. */
export function encodeWorkflowInvocationKeyV2(
  input: Readonly<{
    workflowVersionId: string;
    nodeId: string;
    branchPath?: readonly string[];
    iterationPath?: readonly Readonly<{
      loopNodeId: string;
      ordinal: number;
    }>[];
  }>,
): string {
  const branches = (input.branchPath ?? []).join('/');
  const iterations = (input.iterationPath ?? [])
    .map(({ loopNodeId, ordinal }) => `${loopNodeId}:${String(ordinal)}`)
    .join('/');
  return `${encodeURIComponent(input.workflowVersionId)}|${encodeURIComponent(input.nodeId)}|b:${encodeURIComponent(branches)}|i:${encodeURIComponent(iterations)}`;
}
