import {
  WORKFLOW_VALIDATION_MAX_ISSUES,
  type WorkflowGraph,
} from './workflow-graph.schemas.js';
import { parseWorkflowGraphDraft } from './validation/preflight.js';
import { validateWorkflowGraph } from './validation/validate-workflow-graph.js';
import {
  InvalidWorkflowGraphError,
  type GraphValidationIssue,
} from './validation/graph-validation.js';
import {
  compatibilityForGraph,
  EMPTY_DEFINITION_CATALOG,
  type WorkflowDefinitionCatalog,
} from './definition-catalog.js';
export function parseWorkflowGraphForPublish(
  input: unknown,
  catalog: WorkflowDefinitionCatalog = EMPTY_DEFINITION_CATALOG,
): WorkflowGraph {
  const graph = parseWorkflowGraphDraft(input);
  const validation = validateWorkflowGraph(graph);
  const compatibility = compatibilityForGraph(graph, catalog);
  const compatibilityIssues: GraphValidationIssue[] = compatibility.issues.map(
    (issue) => ({
      code: 'unknown_definition',
      path: '$.nodes',
      message: `unknown definition ${issue.definitionKey}@${String(issue.version)}`,
    }),
  );
  const issues = (
    validation.ok
      ? compatibilityIssues
      : [...validation.issues, ...compatibilityIssues]
  ).slice(0, WORKFLOW_VALIDATION_MAX_ISSUES);
  if (issues.length > 0) throw new InvalidWorkflowGraphError(issues);
  return graph;
}
