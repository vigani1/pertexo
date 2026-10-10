import { parseJsonPath } from '../json/path.js';
import type { WorkflowGraph } from '../graph/contract.js';
import type { GraphValidationIssue } from '../graph/validation/contract.js';
import { callableTypeIssues } from './contract.js';

/** A result is selected across the run, including completed structured scopes. */
export function callableDeclarationIssues(
  graph: WorkflowGraph,
  allNodeIds: ReadonlySet<string>,
): readonly GraphValidationIssue[] {
  if (graph.callable === undefined) return [];
  const { input, resultType, result } = graph.callable;
  const issues: GraphValidationIssue[] = [];
  for (const [name, type] of [
    ['input', input],
    ['resultType', resultType],
  ] as const)
    for (const issue of callableTypeIssues(type))
      issues.push({
        code: 'invalid_graph',
        path: `$.callable.${name}${issue.path.slice(1)}`,
        message:
          issue.code === 'duplicate_property'
            ? 'Callable object properties must have unique names.'
            : 'Callable types must fit the stored JSON depth limit of 64.',
      });
  const entries = graph.nodes.filter(({ definition }) =>
    ['core.manual', 'core.webhook', 'core.schedule'].includes(definition.key),
  );
  if (
    entries.length !== 1 ||
    entries[0]?.definition.key === 'core.schedule' ||
    entries[0]?.disabled === true
  )
    issues.push({
      code: 'invalid_graph',
      path: '$.callable',
      message:
        'A callable workflow requires one enabled Manual or Webhook entry.',
    });
  if (result.kind === 'structured_input')
    issues.push({
      code: 'invalid_mapping',
      path: '$.callable.result',
      message: 'A workflow result cannot select a structured input port.',
    });
  if (result.kind === 'node_output' && !allNodeIds.has(result.nodeId))
    issues.push({
      code: 'invalid_mapping',
      path: '$.callable.result.nodeId',
      message: 'A workflow result must select a node in this workflow.',
    });
  if (
    (result.kind === 'node_output' || result.kind === 'run_input') &&
    parseJsonPath(result.path) === undefined
  )
    issues.push({
      code: 'invalid_mapping',
      path: '$.callable.result.path',
      message: 'A workflow result must use the supported JSON path dialect.',
    });
  return issues;
}
