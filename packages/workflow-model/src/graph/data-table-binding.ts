import {
  isDataTableDefinition,
  isIdBoundFindRows,
  type DataTableFindConfig,
} from '@pertexo/node-sdk';
import {
  AGENT_FIND_ROWS,
  AGENT_STEP_V3,
  readAgentConfig,
} from '../flow/control-nodes/agent.js';
import type { JsonValue } from '../values/json/canonical.js';
import type { WorkflowNode } from './workflow-graph.schemas.js';

type TableBinding = Readonly<{
  location: 'step' | 'tool' | number;
  toolAlias?: string;
  find: boolean;
  idBound: boolean;
  config: DataTableFindConfig;
}>;

export function workflowDataTableBindings(
  node: Pick<WorkflowNode, 'definition' | 'config'>,
): readonly TableBinding[] {
  if (isDataTableDefinition(node.definition))
    return [
      {
        location: 'step',
        find: node.definition.key === AGENT_FIND_ROWS.key,
        idBound: isIdBoundFindRows(node.definition),
        config: node.config as DataTableFindConfig,
      },
    ];
  const settings = readAgentConfig(node);
  return (
    settings?.tools.flatMap((tool, index): TableBinding[] =>
      'table' in tool.config
        ? [
            {
              location:
                node.definition.version === AGENT_STEP_V3.version
                  ? index
                  : 'tool',
              toolAlias: tool.alias,
              find: tool.definition.key === AGENT_FIND_ROWS.key,
              idBound: isIdBoundFindRows(tool.definition),
              config: tool.config,
            },
          ]
        : [],
    ) ?? []
  );
}

export function replaceWorkflowDataTableBinding(
  node: WorkflowNode,
  location: TableBinding['location'],
  { table, tableId, columnBindings }: DataTableFindConfig,
): WorkflowNode {
  const config = {
    table,
    ...(tableId === undefined ? {} : { tableId }),
    ...(columnBindings === undefined ? {} : { columnBindings }),
  };
  if (location === 'step') return { ...node, config };
  if (typeof location === 'number') {
    const tools = node.config.tools as readonly Readonly<
      Record<string, JsonValue>
    >[];
    return {
      ...node,
      config: {
        ...node.config,
        tools: tools.map((tool, index) =>
          index === location ? { ...tool, config } : tool,
        ),
      },
    };
  }
  return {
    ...node,
    config: {
      ...node.config,
      tool: { ...(node.config.tool as Record<string, JsonValue>), config },
    },
  };
}
