import {
  CORE_CODE_CONFIG_SCHEMA,
  CORE_CODE_DEFINITION,
} from '@pertexo/nodes-core';
import type { CodeSettings } from '@pertexo/node-sdk';
import type {
  WorkflowGraph,
  GraphValidationIssue,
} from '@pertexo/workflow-model';

/** Instance policy and shared source validation; no code is evaluated. */
export function codeStepPublicationIssues(
  graph: WorkflowGraph,
  settings: CodeSettings,
): readonly GraphValidationIssue[] {
  const issues: GraphValidationIssue[] = [];
  const levels = [{ graph, path: '$' }];
  for (const level of levels)
    for (const [index, node] of level.graph.nodes.entries()) {
      const path = `${level.path}.nodes[${String(index)}]`;
      if (node.structured !== undefined)
        levels.push({
          graph: node.structured.body,
          path: path + '.structured.body',
        });
      if (
        node.definition.key !== CORE_CODE_DEFINITION.key ||
        node.definition.version !== CORE_CODE_DEFINITION.version
      )
        continue;
      if (!settings.enabled)
        issues.push({
          code: 'invalid_graph',
          path,
          message: 'Code steps are disabled by the administrator.',
        });
      const parsed = CORE_CODE_CONFIG_SCHEMA.safeParse(node.config);
      if (!parsed.success)
        for (const error of parsed.error.issues.slice(0, 20))
          issues.push({
            code: 'invalid_graph',
            path:
              path +
              '.config' +
              error.path.map((part) => '.' + String(part)).join(''),
            message: error.message,
          });
      else if (
        parsed.data.timeoutSeconds !== undefined &&
        parsed.data.timeoutSeconds > settings.maximumSeconds
      )
        issues.push({
          code: 'invalid_graph',
          path: path + '.config.timeoutSeconds',
          message: `Code steps may run for at most ${String(settings.maximumSeconds)} seconds on this instance.`,
        });
    }
  return issues;
}
