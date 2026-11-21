import type {
  InlineNodeInvocation,
  InlineNodeResult,
} from '@pertexo/node-sdk/server';
import { inlineResult } from '../../catalog/inline-result.js';
import type { CoreDateConfig, CoreDateInput } from './date.schemas.js';
import { transformDateValue } from './semantics.js';

export function inlineDate({
  config,
  input,
}: InlineNodeInvocation): InlineNodeResult {
  return inlineResult(() =>
    transformDateValue(config as CoreDateConfig, input as CoreDateInput),
  );
}
