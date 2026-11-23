import {
  validateCallableValue,
  type AgentToolCall,
} from '@pertexo/workflow-model';
import { dataTableValuesSchema } from '@pertexo/node-sdk';
import type { AgentTool } from './agent-scheduler.js';

export function validLegacyToolArguments(
  tool: AgentTool,
  args: AgentToolCall['arguments'],
) {
  if (tool.callable !== undefined)
    return validateCallableValue(tool.callable.input, args) === undefined;
  return (
    Object.keys(args).every((field) =>
      tool.policy.inputFields.includes(field),
    ) &&
    (!('table' in tool.node.config) ||
      tool.policy.effect === 'read' ||
      dataTableValuesSchema.safeParse(args.values).success)
  );
}
