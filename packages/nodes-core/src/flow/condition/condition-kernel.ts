import type {
  InlineNodeInvocation,
  InlineNodeResult,
} from '@pertexo/node-sdk/server';

export function executeCondition(input: unknown) {
  const { condition } = input as { readonly condition: boolean };
  return { selectedPort: condition ? 'true' : 'false' };
}

export function inlineCondition({
  input,
}: InlineNodeInvocation): InlineNodeResult {
  return { kind: 'succeeded', output: executeCondition(input) };
}
