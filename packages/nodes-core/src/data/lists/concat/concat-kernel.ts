import type {
  InlineNodeInvocation,
  InlineNodeResult,
} from '@pertexo/node-sdk/server';
import { inlineResult } from '../../../catalog/inline-result.js';
import type { CoreConcatConfig, CoreConcatInput } from './concat.schemas.js';
import { concatenateItems } from './semantics.js';

export function inlineConcat({
  config,
  input,
}: InlineNodeInvocation): InlineNodeResult {
  return inlineResult(() =>
    concatenateItems(config as CoreConcatConfig, input as CoreConcatInput),
  );
}
