import { utf8ByteLength } from '../../values/text.js';
import { canonicalJson, type JsonValue } from '../../values/json/canonical.js';
import { resolveValueSource } from '../../values/mapping/resolve.js';
import {
  inspectExpression,
  isTemporaryExpressionFailure,
  type ExpressionEvaluator,
} from '../../values/expressions/policy.js';
import {
  EVENT_COORDINATION_LIMITS,
  type EventCoordinationPolicy,
} from './contract.js';

export function inspectEventCoordinationExpression(
  expression: string,
): string | undefined {
  const checked = inspectExpression(expression);
  if (checked.kind === 'error')
    return 'Use a valid restricted JSONata expression for the event key.';
  if (
    checked.callbacks.length > 0 ||
    checked.references.dynamic ||
    checked.references.names.length > 0
  )
    return 'Event keys read event input only, not workspace variables.';
  return undefined;
}
/** Returns canonical key material transiently; persistence hashes it before storing. */
export async function resolveEventCoordinationKey(
  policy: EventCoordinationPolicy,
  input: JsonValue,
  evaluator: ExpressionEvaluator,
  signal?: AbortSignal,
): Promise<
  | Readonly<{ kind: 'key'; canonical: string }>
  | Readonly<{ kind: 'invalid' | 'unavailable' }>
> {
  const result = await resolveValueSource(
    policy.key,
    { runInput: input, nodeOutputs: {} },
    evaluator,
    signal,
  );
  const evaluationUnavailable =
    result.kind === 'error' &&
    result.expression !== undefined &&
    (result.expression.code === 'canceled' ||
      isTemporaryExpressionFailure(result.expression));
  if (evaluationUnavailable) return { kind: 'unavailable' };
  if (result.kind !== 'value') return { kind: 'invalid' };
  const value = result.value;
  if (typeof value === 'string') {
    if (
      value.length === 0 ||
      utf8ByteLength(value) > EVENT_COORDINATION_LIMITS.keyBytes
    )
      return { kind: 'invalid' };
  } else if (
    typeof value !== 'boolean' &&
    !(typeof value === 'number' && Number.isFinite(value))
  )
    return { kind: 'invalid' };
  return { kind: 'key', canonical: canonicalJson(value) };
}
