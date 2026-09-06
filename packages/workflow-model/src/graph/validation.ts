import { z } from 'zod';

import { inspectJsonValue } from '../canonical-json.js';
import {
  WORKFLOW_VALIDATION_MAX_ISSUES,
  type WorkflowGraph,
} from '../graph-contract.js';
import { validateGraphStructure } from '../graph-validation.js';
import {
  WORKFLOW_GRAPH_LIMITS,
  type GraphIssueCode,
  type GraphValidationIssue,
  type GraphValidationResult,
  type WorkflowGraphLimits,
} from './validation-contract.js';

export function validateWorkflowGraph(
  graph: WorkflowGraph,
  overrides: Partial<WorkflowGraphLimits> = {},
): GraphValidationResult {
  const overrideSchema = z
    .object({
      nodes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      edges: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      graphBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      maxLoopIterations: z
        .number()
        .int()
        .positive()
        .max(Number.MAX_SAFE_INTEGER),
      maxLoopConcurrency: z
        .number()
        .int()
        .positive()
        .max(Number.MAX_SAFE_INTEGER),
      maxTotalLoopIterations: z
        .number()
        .int()
        .positive()
        .max(Number.MAX_SAFE_INTEGER),
      maxExpandedInvocations: z
        .number()
        .int()
        .positive()
        .max(Number.MAX_SAFE_INTEGER),
      structuredDepth: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      jsonValueDepth: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      inputDepth: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    })
    .partial()
    .strict();
  const parsedOverrides = overrideSchema.parse(overrides);
  const definedOverrides = Object.fromEntries(
    Object.entries(parsedOverrides).filter((entry) => entry[1] !== undefined),
  ) as Partial<WorkflowGraphLimits>;
  const limits: WorkflowGraphLimits = {
    ...WORKFLOW_GRAPH_LIMITS,
    ...definedOverrides,
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
  const issue = (code: GraphIssueCode, path: string, message: string): void => {
    if (issues.length < WORKFLOW_VALIDATION_MAX_ISSUES)
      issues.push({ code, path, message });
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
