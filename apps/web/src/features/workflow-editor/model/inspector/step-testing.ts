import type { WorkflowGraphContract } from '@pertexo/contracts';
import {
  stepSampleIdentity,
  WORKFLOW_FAILURE_PORT,
} from '@pertexo/workflow-model';
import { findStep, levelOf } from '../graph/scopes';
import { stepTitle } from '../graph/step-title';

// What the inspector's Test tab may do for a step, decided from the graph.

export type PassedTest = Readonly<{ previewId: string; nodeId: string }>;

/** A passed test of a step wired straight into this one can feed its test. */
export function priorTestFor(
  graph: WorkflowGraphContract,
  passed: PassedTest | undefined,
  nodeId: string,
): Readonly<{ id: string; stepName: string }> | undefined {
  if (passed === undefined) return undefined;
  const wired = levelOf(graph, nodeId)?.edges.some(
    (edge) =>
      edge.source.nodeId === passed.nodeId &&
      edge.target.nodeId === nodeId &&
      edge.source.port !== WORKFLOW_FAILURE_PORT,
  );
  const source = findStep(graph, passed.nodeId);
  return (wired ?? false) && source !== undefined
    ? { id: passed.previewId, stepName: stepTitle(source) }
    : undefined;
}

/** The identity a step's pinned sample is kept under. */
export function sampleBinding(
  node: ReturnType<typeof findStep>,
): string | undefined {
  return node === undefined ? undefined : stepSampleIdentity(node);
}
/** Why a single-step preview can't test this step, or undefined when it can. */
export function previewUnavailable(
  node: ReturnType<typeof findStep>,
): string | undefined {
  if (node?.definition.key === 'core.approval')
    return 'Run the workflow to create an approval, then decide it in Approvals. A real preview cannot pause for a human decision.';
  if (node?.definition.key === 'core.call')
    return 'Run this workflow to test the Call with its child. A real single-step preview cannot return a child result.';
  if (
    Object.values(node?.inputMappings ?? {}).some(
      (source) => source.kind === 'node_failure',
    )
  )
    return 'This handler reads an actual failure. Run the workflow to verify its failure path; a real single-step preview cannot supply that evidence.';
  return undefined;
}

/** A Webhook step listens for a real test request while its Test tab is open. */
export function listensForTestRequests(
  node: ReturnType<typeof findStep>,
): boolean {
  return node?.definition.key === 'core.webhook';
}
