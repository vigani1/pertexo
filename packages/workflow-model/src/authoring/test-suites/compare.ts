import { canonicalJson, type JsonValue } from '../../values/json/canonical.js';
import { resolveJsonPath } from '../../values/json/path.js';
import type { TestAssertion } from './contract.js';

export function matchesTestAssertion(
  actual: JsonValue,
  operator: TestAssertion['operator'],
  expected: JsonValue,
): boolean {
  const expectedText = canonicalJson(expected);
  const equals = (value: JsonValue) => canonicalJson(value) === expectedText;
  if (operator === 'equals') return equals(actual);
  if (typeof actual === 'string')
    return typeof expected === 'string' && actual.includes(expected);
  if (Array.isArray(actual)) return actual.some(equals);
  if (
    actual === null ||
    typeof actual !== 'object' ||
    expected === null ||
    typeof expected !== 'object' ||
    Array.isArray(expected)
  )
    return false;
  const object = actual as Readonly<Record<string, JsonValue>>;
  return Object.entries(expected).every(
    ([key, value]) =>
      Object.hasOwn(object, key) &&
      canonicalJson(object[key]) === canonicalJson(value),
  );
}
export type TestAssertionObservation = Readonly<{
  state: 'value' | 'missing' | 'unavailable' | 'ambiguous';
  matched: boolean;
  value?: JsonValue;
  preview?: string;
  bytes?: number;
  truncated?: boolean;
}>;
/** Paths and expected values have already passed the suite boundary. */
export function observeTestAssertion(
  output: JsonValue,
  assertion: TestAssertion,
): TestAssertionObservation {
  const resolved = resolveJsonPath(output, assertion.path);
  if (resolved.kind !== 'value') return { state: 'missing', matched: false };
  const matched = matchesTestAssertion(
    resolved.value,
    assertion.operator,
    assertion.expected,
  );
  const text = canonicalJson(resolved.value);
  const bytes = new TextEncoder().encode(text).byteLength;
  return bytes <= 4096
    ? { state: 'value', matched, value: resolved.value }
    : {
        state: 'value',
        matched,
        preview: Array.from(text).slice(0, 1000).join(''),
        bytes,
        truncated: true,
      };
}
