import {
  AGENT_FIND_ROWS,
  AGENT_INSERT_ROW,
  AGENT_SEND_SLACK_MESSAGE,
  isRecord,
  WORKFLOW_CALL,
} from '@pertexo/workflow-model';
import type { NodeConfig } from './inspector/draft';

export const AGENT_TOOLS = [
  { definition: AGENT_FIND_ROWS, label: 'Find rows' },
  { definition: AGENT_INSERT_ROW, label: 'Insert row' },
  { definition: AGENT_SEND_SLACK_MESSAGE, label: 'Send Slack message' },
  { definition: WORKFLOW_CALL, label: 'Call workflow' },
] as const;

export function configuredAgentTool(config: NodeConfig) {
  const definition = isRecord(config.tool) ? config.tool.definition : undefined;
  const key = isRecord(definition) ? definition.key : undefined;
  return (
    AGENT_TOOLS.find((tool) => tool.definition.key === key) ?? AGENT_TOOLS[0]
  );
}
