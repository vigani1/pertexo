import type {
  InlineNodeInvocation,
  InlineNodeResult,
  JsonValue,
} from '@pertexo/node-sdk/server';
import type { z } from 'zod';
import type { CORE_MERGE_INPUT_SCHEMA } from './merge.schemas.js';

type CoreMergeInput = z.output<typeof CORE_MERGE_INPUT_SCHEMA>;

export function executeMerge(input: unknown) {
  const { ledger, selectedBranchIds } = input as CoreMergeInput;
  return {
    branches: Object.fromEntries(
      selectedBranchIds.map((id) => [
        id,
        (ledger[id]?.output ?? null) as JsonValue,
      ]),
    ),
    selectedBranchIds,
  };
}

export function inlineMerge({ input }: InlineNodeInvocation): InlineNodeResult {
  return { kind: 'succeeded', output: executeMerge(input) };
}
