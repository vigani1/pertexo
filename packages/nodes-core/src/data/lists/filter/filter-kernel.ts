import type {
  InlineNodeInvocation,
  InlineNodeResult,
} from '@pertexo/node-sdk/server';
import { inlineResult } from '../../../catalog/inline-result.js';
import type { CoreFilterConfig, CoreFilterInput } from './filter.schemas.js';
import { filterItems } from './semantics.js';

export function inlineFilter({
  config,
  input,
}: InlineNodeInvocation): InlineNodeResult {
  return inlineResult(() =>
    filterItems(config as CoreFilterConfig, input as CoreFilterInput),
  );
}
