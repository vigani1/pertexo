import { createHash } from 'node:crypto';
import { types } from 'node:util';
import {
  serializeStoredExecutionJsonValue,
  serializeWorkflowExecutionJsonValueV3,
} from '../stored-execution-value.js';

function ownFields(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    types.isProxy(value)
  )
    throw new TypeError('Invalid coordinator plan fields');
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype)
    throw new TypeError('Invalid coordinator plan prototype');
  const fields: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  const keys = Reflect.ownKeys(value);
  if (keys.length > 16)
    throw new TypeError('Invalid coordinator plan field count');
  for (const key of keys) {
    if (typeof key !== 'string')
      throw new TypeError('Invalid coordinator plan field');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    )
      throw new TypeError('Invalid coordinator plan descriptor');
    fields[key] = descriptor.value as unknown;
  }
  return fields;
}

/** Keep the established 256 KiB plan budget independent of the 1 MiB result. */
export function normalizeCoordinatorPlan(value: unknown): unknown {
  const fields = ownFields(value);
  const result = fields.callableResult;
  if (result === undefined)
    return JSON.parse(serializeStoredExecutionJsonValue(fields)) as unknown;
  const resultFields = ownFields(result);
  if (resultFields.kind !== 'succeeded')
    return JSON.parse(serializeStoredExecutionJsonValue(fields)) as unknown;
  const resultValue = JSON.parse(
    serializeWorkflowExecutionJsonValueV3(resultFields.value),
  ) as unknown;
  fields.callableResult = { ...resultFields, value: null };
  const normalized = JSON.parse(
    serializeStoredExecutionJsonValue(fields),
  ) as Record<string, unknown>;
  normalized.callableResult = {
    ...(normalized.callableResult as Record<string, unknown>),
    value: resultValue,
  };
  return normalized;
}

/** Bind native result bytes without combining independently bounded budgets. */
export function coordinatorPlanFingerprintJson(
  plan: Readonly<{
    callableResult?: Readonly<{ kind: string; value?: unknown }> | undefined;
  }>,
): string {
  const result = plan.callableResult;
  if (result?.kind !== 'succeeded')
    return serializeStoredExecutionJsonValue(plan);
  const bytes = serializeWorkflowExecutionJsonValueV3(result.value);
  return serializeStoredExecutionJsonValue({
    ...plan,
    callableResult: {
      ...result,
      value: {
        byteLength: Buffer.byteLength(bytes, 'utf8'),
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    },
  });
}
