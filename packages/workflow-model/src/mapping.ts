import './server-only.js';
import { canonicalizeJson, type JsonValue } from './canonical-json.js';
import {
  JsonataEvaluator,
  type ExpressionContextV1,
  type ExpressionResult,
} from './expressions.js';
import type { ValueSource } from './graph.js';

export type ValueResolution =
  | { readonly kind: 'value'; readonly value: JsonValue }
  | { readonly kind: 'missing' }
  | {
      readonly kind: 'error';
      readonly code: 'invalid_path' | 'expression_error';
      readonly message: string;
      readonly expression?: Extract<ExpressionResult, { kind: 'error' }>;
    };
export interface ValueResolutionContext extends ExpressionContextV1 {
  readonly structuredInputs?: Readonly<Record<string, JsonValue>>;
}
type Segment = string | number;
function parsePath(path: string): Segment[] | undefined {
  if (path === '$') return [];
  if (!path.startsWith('$')) return undefined;
  const result: Segment[] = [];
  let offset = 1;
  while (offset < path.length) {
    if (path[offset] === '.') {
      const match = /^\.([A-Za-z_][A-Za-z0-9_-]*)/u.exec(path.slice(offset));
      if (!match) return undefined;
      const name = match[1];
      if (name === undefined) return undefined;
      result.push(name);
      offset += match[0].length;
      continue;
    }
    const index = /^\[(0|[1-9][0-9]*)\]/u.exec(path.slice(offset));
    if (index) {
      result.push(Number(index[1]));
      offset += index[0].length;
      continue;
    }
    const property = /^\['((?:[^'\\]|\\['\\])*)'\]/u.exec(path.slice(offset));
    if (property) {
      const name = property[1];
      if (name === undefined) return undefined;
      result.push(name.replace(/\\(['\\])/gu, '$1'));
      offset += property[0].length;
      continue;
    }
    return undefined;
  }
  return result;
}
export function resolveJsonPath(
  input: JsonValue,
  path: string,
): ValueResolution {
  const segments = parsePath(path);
  if (!segments)
    return {
      kind: 'error',
      code: 'invalid_path',
      message: `unsupported JSON path ${path}`,
    };
  let value: JsonValue | undefined = input;
  for (const segment of segments) {
    if (value === null || typeof value !== 'object') return { kind: 'missing' };
    if (typeof segment === 'number') {
      if (!Array.isArray(value) || segment >= value.length)
        return { kind: 'missing' };
      const next: JsonValue | undefined = (value as readonly JsonValue[])[
        segment
      ];
      if (next === undefined) return { kind: 'missing' };
      value = next;
    } else {
      if (Array.isArray(value) || !Object.hasOwn(value, segment))
        return { kind: 'missing' };
      value = (value as Readonly<Record<string, JsonValue>>)[segment];
    }
  }
  return value === undefined ? { kind: 'missing' } : { kind: 'value', value };
}
const sharedEvaluator = new JsonataEvaluator();
export async function resolveValueSource(
  source: ValueSource,
  context: ValueResolutionContext,
  evaluator: JsonataEvaluator = sharedEvaluator,
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
    policyVersion: source.policyVersion,
    context,
    ...(signal === undefined ? {} : { signal }),
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
