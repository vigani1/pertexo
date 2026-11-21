import type {
  InlineNodeInvocation,
  InlineNodeResult,
} from '@pertexo/node-sdk/server';
import { inlineResult } from '../../../catalog/inline-result.js';
import { boundedUtilityResult } from '../utility-result.js';
import { formatNumber } from './format-number.js';
import type { NumberConfig } from './number.schemas.js';

export function inlineNumber({
  config,
  input,
}: InlineNodeInvocation): InlineNodeResult {
  return inlineResult(() =>
    boundedUtilityResult(
      formatNumber(config as NumberConfig, (input as { value: number }).value),
    ),
  );
}
