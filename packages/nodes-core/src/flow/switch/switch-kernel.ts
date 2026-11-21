import type {
  InlineNodeInvocation,
  InlineNodeResult,
} from '@pertexo/node-sdk/server';
import type { SwitchConfig } from '@pertexo/workflow-model';
import type { CoreSwitchInput } from './switch.schemas.js';

export function executeSwitch(config: unknown, input: unknown) {
  const { cases } = config as SwitchConfig;
  const { value } = input as CoreSwitchInput;
  return {
    selectedPort: cases.find(({ equals }) => equals === value)?.id ?? 'default',
  };
}

export function inlineSwitch({
  config,
  input,
}: InlineNodeInvocation): InlineNodeResult {
  return { kind: 'succeeded', output: executeSwitch(config, input) };
}
