import { isRecord, type JsonValue } from '@pertexo/workflow-model';

import { WorkflowEngineError } from './errors.js';
import { hasExactFields } from './exact-fields.js';

export function operationError(
  code:
    | 'observation_invalid'
    | 'attempt_invalid'
    | 'variable_missing'
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
  return isRecord(value);
}

export function exactKeys(
  value: Readonly<Record<string, JsonValue>>,
  required: readonly string[],
  optional: readonly string[] = [],
  code: 'observation_invalid' | 'attempt_invalid' = 'observation_invalid',
): void {
  if (!hasExactFields(value, required, optional))
    operationError(code, 'observation fields are invalid');
}
