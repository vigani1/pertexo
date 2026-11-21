import type {
  InlineNodeInvocation,
  InlineNodeResult,
} from '@pertexo/node-sdk/server';
import { inlineResult } from '../../../catalog/inline-result.js';
import type {
  CoreSummarizeConfig,
  CoreSummarizeInput,
} from './summarize.schemas.js';
import { summarizeItems } from './semantics.js';

export function inlineSummarize({
  config,
  input,
}: InlineNodeInvocation): InlineNodeResult {
  return inlineResult(() =>
    summarizeItems(config as CoreSummarizeConfig, input as CoreSummarizeInput),
  );
}
