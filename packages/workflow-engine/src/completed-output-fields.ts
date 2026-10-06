import { types as nodeTypes } from 'node:util';
import { NODE_JSON_LIMITS_V1 } from '@pertexo/node-sdk';
import { operationError } from './operation-values.js';

/** Inspect metadata containers only; source values have independent budgets. */
export function ownCompletedFields(
  value: unknown,
  code: 'attempt_invalid' | 'observation_invalid',
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || nodeTypes.isProxy(value))
    operationError(code, 'completed output metadata is invalid');
  const array = Array.isArray(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (
    (prototype !== null &&
      prototype !== (array ? Array.prototype : Object.prototype)) ||
    Object.getOwnPropertySymbols(value).length !== 0
  )
    operationError(code, 'completed output metadata is invalid');
  const names = Object.getOwnPropertyNames(value);
  const length: unknown = array
    ? Object.getOwnPropertyDescriptor(value, 'length')?.value
    : undefined;
  if (
    names.length > NODE_JSON_LIMITS_V1.members + (array ? 1 : 0) ||
    (array &&
      (typeof length !== 'number' ||
        !Number.isSafeInteger(length) ||
        length > NODE_JSON_LIMITS_V1.members ||
        names.length !== length + 1))
  )
    operationError(code, 'completed output metadata exceeds limits');
  for (const name in value)
    if (!Object.hasOwn(value, name))
      operationError(code, 'completed output metadata is inherited');
  const fields = Object.create(null) as Record<string, unknown>;
  let ordinal = 0;
  for (const name of names) {
    if (array && name === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !('value' in descriptor) ||
      (array && name !== String(ordinal++))
    )
      operationError(code, 'completed output metadata is invalid');
    fields[name] = descriptor.value;
  }
  return fields;
}
