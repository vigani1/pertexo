import {
  isDataTableDefinition,
  type DataTableFindConfig,
} from '@pertexo/node-sdk';
import {
  AGENT_FIND_ROWS,
  agentConfigSchema,
  isAgentDefinition,
} from '../flow/control-nodes/agent.js';
import type { JsonValue } from '../values/json/canonical.js';
import type { WorkflowNode } from './workflow-graph.schemas.js';

export function workflowDataTableBinding(
  node: Pick<WorkflowNode, 'definition' | 'config'>,
) {
  if (isDataTableDefinition(node.definition))
    return {
      location: 'step' as const,
      find: node.definition.key === AGENT_FIND_ROWS.key,
      config: node.config as DataTableFindConfig,
    };
  if (!isAgentDefinition(node.definition)) return undefined;
  const settings = agentConfigSchema.safeParse(node.config);
  if (!settings.success || !('table' in settings.data.tool.config))
    return undefined;
  return {
    location: 'tool' as const,
    find: settings.data.tool.definition.key === AGENT_FIND_ROWS.key,
    config: settings.data.tool.config as DataTableFindConfig,
  };
}

export function replaceWorkflowDataTableBinding(
  node: WorkflowNode,
  location: 'step' | 'tool',
  { table, tableId, columnBindings }: DataTableFindConfig,
): WorkflowNode {
  const config = {
    table,
    ...(tableId === undefined ? {} : { tableId }),
    ...(columnBindings === undefined ? {} : { columnBindings }),
  };
  if (location === 'step') return { ...node, config };
  return {
    ...node,
    config: {
      ...node.config,
      tool: { ...(node.config.tool as Record<string, JsonValue>), config },
    },
  };
}
