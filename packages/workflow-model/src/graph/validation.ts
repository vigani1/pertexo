import { inspectJsonValue } from '../json/canonical-json.js';
import {
  WORKFLOW_VALIDATION_MAX_ISSUES,
  type WorkflowGraph,
} from './contract.js';
import { validateGraphStructure } from './structure.js';
import {
  WORKFLOW_GRAPH_LIMITS,
  type GraphIssueCode,
  type GraphValidationIssue,
  type GraphValidationResult,
  type WorkflowGraphLimits,
} from './validation-contract.js';

/**
 * Checks a parsed graph against the structural rules and limits. Authoring
 * validation passes admitIssue to bound its report; it may throw to stop.
 */
export function validateWorkflowGraph(
  graph: WorkflowGraph,
  limitOverrides: Partial<WorkflowGraphLimits> = {},
  admitIssue?: (issue: GraphValidationIssue) => void,
): GraphValidationResult {
  const limits: WorkflowGraphLimits = {
    ...WORKFLOW_GRAPH_LIMITS,
    ...limitOverrides,
  };
  const issues: GraphValidationIssue[] = [];
  const globalNodeIds = new Set<string>();
  const allNodeIds = new Set<string>();
  const pendingGraphs: WorkflowGraph[] = [graph];
  while (pendingGraphs.length > 0) {
    const current = pendingGraphs.pop();
    if (current === undefined) continue;
    for (const node of current.nodes) {
      allNodeIds.add(node.id);
      if (node.structured !== undefined)
        pendingGraphs.push(node.structured.body);
    }
  }
  const aggregate = { nodes: 0, edges: 0 };
  const issueCollection = { failed: false };
  const issue = (code: GraphIssueCode, path: string, message: string): void => {
    if (issues.length >= WORKFLOW_VALIDATION_MAX_ISSUES) return;
    const candidate = { code, path, message };
    try {
      admitIssue?.(candidate);
    } catch (error) {
      issueCollection.failed = true;
      throw error;
    }
    issues.push(candidate);
  };
  let expandedInvocations = 0;
  let worstCaseLoopIterations = 0;
  try {
    if (inspectJsonValue(graph).bytes > limits.graphBytes)
      issue('graph_limit', '$', 'canonical graph bytes exceed the limit');
    const totals = validateGraphStructure(graph, '$', {
      aggregate,
      allNodeIds,
      globalNodeIds,
      issue,
      limits,
    });
    expandedInvocations = totals.expanded;
    worstCaseLoopIterations = totals.iterations;
  } catch (error) {
    // Collector refusal is operational, not evidence that the graph is invalid.
    if (issueCollection.failed) throw error;
    issue(
      'invalid_graph',
      '$',
      error instanceof Error ? error.message : 'graph is not canonical JSON',
    );
  }
  if (expandedInvocations > limits.maxExpandedInvocations)
    issue(
      'expansion_limit',
      '$',
      `worst-case expansion ${String(expandedInvocations)} exceeds ${String(limits.maxExpandedInvocations)}`,
    );
  if (worstCaseLoopIterations > limits.maxTotalLoopIterations)
    issue(
      'loop_iteration_limit',
      '$',
      `worst-case loop iterations ${String(worstCaseLoopIterations)} exceeds ${String(limits.maxTotalLoopIterations)}`,
    );
  return issues.length === 0
    ? {
        ok: true,
        issues: [],
        expandedInvocations,
        worstCaseLoopIterations,
      }
    : { ok: false, issues, expandedInvocations, worstCaseLoopIterations };
}
