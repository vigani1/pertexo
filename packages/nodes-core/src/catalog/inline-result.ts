import type { InlineNodeResult, JsonValue } from '@pertexo/node-sdk/server';
import { CoreStepRefusal } from './core-step.errors.js';

export function inlineResult(execute: () => JsonValue): InlineNodeResult {
  try {
    return { kind: 'succeeded', output: execute() };
  } catch (error) {
    if (!(error instanceof CoreStepRefusal)) throw error;
    return { kind: 'failed', failure: error.failure };
  }
}
