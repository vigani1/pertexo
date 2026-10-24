import { lookupWorkspaceVariable } from '../variables/lookup.js';
import { normalizeJson, type JsonValue } from '../json/canonical.js';
import type {
  ExpressionContext,
  ExpressionEvaluator,
  ExpressionResult,
} from '../expressions/policy.js';
import type { ValueSource } from '../../graph/contract.js';
import { resolveJsonPath } from '../json/path.js';
import type { WorkflowNodeFailureValue } from '../../flow/failure-routing/value.js';

export type ValueResolution =
  | { readonly kind: 'value'; readonly value: JsonValue }
  | { readonly kind: 'missing' }
  | {
      readonly kind: 'error';
      readonly code: 'invalid_path' | 'expression_error' | 'variable_missing';
      readonly message: string;
      readonly expression?: Extract<ExpressionResult, { kind: 'error' }>;
    };
export interface ValueResolutionContext extends ExpressionContext {
  readonly structuredInputs?: Readonly<Record<string, JsonValue>>;
  readonly nodeFailure?: WorkflowNodeFailureValue;
}
export async function resolveValueSource(
  source: ValueSource,
  context: ValueResolutionContext,
  evaluator?: ExpressionEvaluator,
  signal?: AbortSignal,
): Promise<ValueResolution> {
  if (source.kind === 'workspace_variable')
    return lookupWorkspaceVariable(source.name, context.variables ?? {});
  if (source.kind === 'literal')
    return { kind: 'value', value: normalizeJson(source.value) };
  if (source.kind === 'run_input')
    return resolveJsonPath(context.runInput, source.path);
  if (source.kind === 'node_output') {
    const output = context.nodeOutputs[source.nodeId];
    return output === undefined
      ? { kind: 'missing' }
      : resolveJsonPath(output, source.path);
  }
  if (source.kind === 'node_failure') {
    return context.nodeFailure?.nodeId === source.nodeId
      ? resolveJsonPath(context.nodeFailure, source.path)
      : { kind: 'missing' };
  }
  if (source.kind === 'structured_input') {
    const input = context.structuredInputs?.[source.port];
    return input === undefined
      ? { kind: 'missing' }
      : resolveJsonPath(input, source.path);
  }
  const request = {
    expression: source.expression,
    // Expressions read the loop's ports as `loop.item` and `loop.ordinal`.
    context:
      context.structuredInputs === undefined
        ? context
        : { ...context, loop: context.structuredInputs },
    ...(signal === undefined ? {} : { signal }),
  };
  if (evaluator === undefined)
    return {
      kind: 'error',
      code: 'expression_error',
      message: 'expression evaluator is not configured',
    };
  const result = await evaluator.evaluate(request);
  if (result.kind === 'error')
    return {
      kind: 'error',
      code: 'expression_error',
      message: result.message,
      expression: result,
    };
  if (result.kind === 'missing') return result;
  return { kind: 'value', value: result.value };
}
