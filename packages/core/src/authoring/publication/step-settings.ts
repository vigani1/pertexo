import {
  WORKFLOW_VALIDATION_MAX_ISSUES,
  workflowNodes,
  type GraphValidationIssue,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import type { PortableCatalog } from '../workflows/types.js';

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
  return [...workflowNodes(graph)]
    .filter((node) => !accepts(node))
    .slice(0, WORKFLOW_VALIDATION_MAX_ISSUES)
    .map((node) => ({
      code: 'invalid_step_settings',
      path: `$.nodes.${node.id}.config`,
      message: `${node.label ?? 'This step'} has settings it can't run with. Open the step and check its values against their limits`,
    }));
}
