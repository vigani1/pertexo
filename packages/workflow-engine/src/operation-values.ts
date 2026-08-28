import type { JsonValue } from '@pertexo/workflow-model/canonical-json';

import { WorkflowEngineError } from './errors.js';

export function operationError(
  code:
    | 'observation_invalid'
    | 'attempt_invalid'
    | 'attempt_aborted'
    | 'workflow_identity_invalid',
  message: string,
): never {
  throw new WorkflowEngineError(code, message);
}

export function record(
  value: JsonValue,
  code: 'observation_invalid' | 'attempt_invalid',
  label: string,
): Readonly<Record<string, JsonValue>> {
  if (!isJsonRecord(value)) operationError(code, `${label} must be an object`);
  return value;
}

export function isJsonRecord(
  value: unknown,
): value is Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function exactKeys(
  value: Readonly<Record<string, JsonValue>>,
  required: readonly string[],
  optional: readonly string[] = [],
  code: 'observation_invalid' | 'attempt_invalid' = 'observation_invalid',
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    !required.every((key) => Object.hasOwn(value, key)) ||
    !Object.keys(value).every((key) => allowed.has(key))
  )
    operationError(code, 'observation fields are invalid');
}
