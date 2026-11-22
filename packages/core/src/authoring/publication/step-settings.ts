import {
  WORKFLOW_VALIDATION_MAX_ISSUES,
  agentConfigSchema,
  isAgentDefinition,
  type GraphValidationIssue,
  type WorkflowGraph,
  type WorkflowNode,
} from '@pertexo/workflow-model';
import type { PortableCatalog } from '../workflows/authoring-dependencies.types.js';

/**
 * Settings a run could only refuse. Without this they publish cleanly and every
 * run then fails with `execution.attempt_invalid`, far from the step at fault.
 */
export function stepSettingsIssues(
  graph: WorkflowGraph,
  catalog: PortableCatalog | undefined,
): readonly GraphValidationIssue[] {
  const accepts = catalog?.acceptsStepConfig;
  if (accepts === undefined) return [];
  return [...stepsThatCanRun(graph)]
    .filter((node) => !accepts(node))
    .slice(0, WORKFLOW_VALIDATION_MAX_ISSUES)
    .map(stepSettingsIssue);
}

function stepSettingsIssue(node: WorkflowNode): GraphValidationIssue {
  const path = `$.nodes.${node.id}.config`;
  if (isAgentDefinition(node.definition)) {
    const config = agentConfigSchema.safeParse(node.config);
    const deadline = config.error?.issues.find(
      (issue) => issue.code === 'custom' && issue.path[0] === 'timeoutMillis',
    );
    if (deadline !== undefined)
      return {
        code: 'invalid_step_settings',
        path: `${path}.timeoutMillis`,
        message: deadline.message,
      };
  }
  return {
    code: 'invalid_step_settings',
    path,
    message: `${node.label ?? 'This step'} has settings it can't run with. Open the step and check its values against their limits`,
  };
}

/** A disabled step, and any loop body inside it, never runs. */
function* stepsThatCanRun(graph: WorkflowGraph): Generator<WorkflowNode> {
  for (const node of graph.nodes) {
    if (node.disabled) continue;
    yield node;
    if (node.structured !== undefined)
      yield* stepsThatCanRun(node.structured.body);
  }
}
