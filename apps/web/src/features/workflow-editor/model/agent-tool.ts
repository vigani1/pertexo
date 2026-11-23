import {
  AGENT_INSERT_ROW,
  AGENT_STEP,
  AGENT_SEND_SLACK_MESSAGE,
  AGENT_SLACK_CONNECTION_SLOT,
  isRecord,
  WORKFLOW_CALL,
} from '@pertexo/workflow-model';
import { FIND_ROWS_V1, FIND_ROWS_V2 } from '@pertexo/node-sdk';
import { withConfigValue, type NodeConfig } from './inspector/draft';
import type { NodeFormApi } from './inspector/node-form';

export function agentTools(agentVersion: 1 | 2 | 3) {
  return [
    {
      definition:
        agentVersion === AGENT_STEP.version ? FIND_ROWS_V1 : FIND_ROWS_V2,
      label: 'Find rows',
    },
    { definition: AGENT_INSERT_ROW, label: 'Insert row' },
    { definition: AGENT_SEND_SLACK_MESSAGE, label: 'Send Slack message' },
    { definition: WORKFLOW_CALL, label: 'Call workflow' },
  ] as const;
}

export function configuredAgentTool(
  config: NodeConfig,
  tools: ReturnType<typeof agentTools>,
) {
  const definition = isRecord(config.tool) ? config.tool.definition : undefined;
  const key = isRecord(definition) ? definition.key : undefined;
  return tools.find((tool) => tool.definition.key === key) ?? tools[0];
}

export function agentDraftTools(config: NodeConfig): readonly NodeConfig[] {
  if (Array.isArray(config.tools))
    return config.tools.filter(isRecord) as readonly NodeConfig[];
  return isRecord(config.tool) ? [config.tool as NodeConfig] : [];
}

export function hasSlackAgentTool(tools: readonly NodeConfig[]): boolean {
  return tools.some(
    ({ definition }) =>
      isRecord(definition) && definition.key === AGENT_SEND_SLACK_MESSAGE.key,
  );
}

export function retainedAgentConnections<
  T extends Readonly<Record<string, string>>,
>(connections: T, tools: readonly NodeConfig[]) {
  if (hasSlackAgentTool(tools)) return connections;
  const { [AGENT_SLACK_CONNECTION_SLOT]: _unused, ...rest } = connections;
  return rest;
}

export function toolFormAt(form: NodeFormApi, index: number): NodeFormApi {
  return {
    ...form,
    nodeId: `${form.nodeId}-tool-${String(index)}`,
    reportScratch: (field, scratch) => {
      form.reportScratch(`tool:${String(index)}:${field}`, scratch);
    },
    commit: (update, key) => {
      form.commit(
        (node) => {
          const tools = [...agentDraftTools(node.config)];
          const current = tools[index] ?? {};
          const change =
            typeof update === 'function'
              ? update({ ...node, config: { ...node.config, tool: current } })
              : update;
          if (change.config === undefined) return change;
          const { tool, ...config } = change.config;
          tools[index] = isRecord(tool) ? (tool as NodeConfig) : current;
          return {
            ...change,
            config: withConfigValue(config, 'tools', tools),
            ...(change.connectionRefs === undefined
              ? {}
              : {
                  connectionRefs: retainedAgentConnections(
                    hasSlackAgentTool(tools)
                      ? node.connectionRefs
                      : change.connectionRefs,
                    tools,
                  ),
                }),
          };
        },
        `tool:${String(index)}:${key}`,
      );
    },
  };
}
