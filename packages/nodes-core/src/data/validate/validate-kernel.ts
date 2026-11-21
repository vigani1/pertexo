import type {
  InlineNodeInvocation,
  InlineNodeResult,
} from '@pertexo/node-sdk/server';
import { inlineResult } from '../../catalog/inline-result.js';
import type { CoreValidateConfig } from './validate.schemas.js';
import { evaluateCoreValidate } from './semantics.js';

export function inlineValidate({
  config,
  input,
}: InlineNodeInvocation): InlineNodeResult {
  return inlineResult(() =>
    evaluateCoreValidate(config as CoreValidateConfig, input),
  );
}
