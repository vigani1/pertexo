import type {
  InlineNodeInvocation,
  InlineNodeResult,
} from '@pertexo/node-sdk/server';
import { inlineResult } from '../../../catalog/inline-result.js';
import type { CoreUniqueConfig, CoreUniqueInput } from './unique.schemas.js';
import { uniqueItems } from './semantics.js';

export function inlineUnique({
  config,
  input,
}: InlineNodeInvocation): InlineNodeResult {
  return inlineResult(() =>
    uniqueItems(config as CoreUniqueConfig, input as CoreUniqueInput),
  );
}
