import {
  AGENT_INSERT_ROW,
  AGENT_SEND_SLACK_MESSAGE,
  isRecord,
  WORKFLOW_CALL,
} from '@pertexo/workflow-model';
import { FIND_ROWS_V1, FIND_ROWS_V2 } from '@pertexo/node-sdk';
import type { NodeConfig } from './inspector/draft';

export function agentTools(agentVersion: 1 | 2) {
  return [
    {
      definition: agentVersion === 2 ? FIND_ROWS_V2 : FIND_ROWS_V1,
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
