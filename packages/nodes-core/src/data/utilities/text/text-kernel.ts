import type {
  InlineNodeInvocation,
  InlineNodeResult,
} from '@pertexo/node-sdk/server';
import { inlineResult } from '../../../catalog/inline-result.js';
import { boundedUtilityResult } from '../utility-result.js';
import { transformText } from './transform-text.js';
import type { TextConfig, TextInput } from './text.schemas.js';

export function inlineText({
  config,
  input,
}: InlineNodeInvocation): InlineNodeResult {
  return inlineResult(() =>
    boundedUtilityResult(
      transformText(config as TextConfig, input as TextInput),
    ),
  );
}
