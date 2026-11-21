import type {
  InlineNodeInvocation,
  InlineNodeResult,
} from '@pertexo/node-sdk/server';
import { inlineResult } from '../../../catalog/inline-result.js';
import type { CoreTakeConfig, CoreTakeInput } from './take.schemas.js';
import { takeItems } from './semantics.js';

export function inlineTake({
  config,
  input,
}: InlineNodeInvocation): InlineNodeResult {
  return inlineResult(() =>
    takeItems(config as CoreTakeConfig, input as CoreTakeInput),
  );
}
