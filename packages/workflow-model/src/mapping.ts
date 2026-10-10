import { canonicalizeJson, type JsonValue } from './json/canonical.js';
import type {
  ExpressionContext,
  ExpressionEvaluator,
  ExpressionResult,
} from './expressions/policy.js';
import type { ValueSource } from './graph/contract.js';
import { resolveJsonPath } from './json/path.js';

export type ValueResolution =
  | { readonly kind: 'value'; readonly value: JsonValue }
  | { readonly kind: 'missing' }
  | {
      readonly kind: 'error';
      readonly code: 'invalid_path' | 'expression_error';
      readonly message: string;
      readonly expression?: Extract<ExpressionResult, { kind: 'error' }>;
    };
export interface ValueResolutionContext extends ExpressionContext {
  readonly structuredInputs?: Readonly<Record<string, JsonValue>>;
}
export async function resolveValueSource(
  source: ValueSource,
  context: ValueResolutionContext,
  evaluator?: ExpressionEvaluator,
  signal?: AbortSignal,
): Promise<ValueResolution> {
  if (source.kind === 'literal')
    return { kind: 'value', value: canonicalizeJson(source.value) };
  if (source.kind === 'run_input')
    return resolveJsonPath(context.runInput, source.path);
  if (source.kind === 'node_output') {
    const output = context.nodeOutputs[source.nodeId];
    return output === undefined
      ? { kind: 'missing' }
      : resolveJsonPath(output, source.path);
  }
  if (source.kind === 'structured_input') {
    const input = context.structuredInputs?.[source.port];
    return input === undefined
      ? { kind: 'missing' }
      : resolveJsonPath(input, source.path);
  }
  const request = {
    expression: source.expression,
    context,
    ...(signal === undefined ? {} : { signal }),
  };
  if (evaluator === undefined)
    return {
      kind: 'error',
      code: 'expression_error',
      message: 'expression evaluator is not configured',
    };
  const result = await evaluator.evaluate(request);
  return result.kind === 'error'
    ? {
        kind: 'error',
        code: 'expression_error',
        message: result.message,
        expression: result,
      }
    : result.kind === 'missing'
      ? result
      : { kind: 'value', value: result.value };
}
