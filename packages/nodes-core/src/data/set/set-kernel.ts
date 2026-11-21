import type {
  InlineNodeInvocation,
  InlineNodeResult,
  JsonValue,
} from '@pertexo/node-sdk/server';

export function executeSet(input: JsonValue) {
  return input;
}

export function inlineSet({ input }: InlineNodeInvocation): InlineNodeResult {
  return { kind: 'succeeded', output: executeSet(input) };
}
