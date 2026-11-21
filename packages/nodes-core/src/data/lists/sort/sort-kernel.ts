import type {
  InlineNodeInvocation,
  InlineNodeResult,
} from '@pertexo/node-sdk/server';
import { inlineResult } from '../../../catalog/inline-result.js';
import type { CoreSortConfig, CoreSortInput } from './sort.schemas.js';
import { sortItems } from './semantics.js';

export function inlineSort({
  config,
  input,
}: InlineNodeInvocation): InlineNodeResult {
  return inlineResult(() =>
    sortItems(config as CoreSortConfig, input as CoreSortInput),
  );
}
