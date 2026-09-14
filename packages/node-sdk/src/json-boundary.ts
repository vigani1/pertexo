import type { JsonValue } from './executor-contracts.js';
import { InvalidBoundedJsonError } from './executor-errors.js';
import {
  inspectBoundedJson,
  NODE_JSON_LIMITS_V1,
  type BoundedJsonLimits,
} from './bounded-json.js';

// eslint-disable-next-line @typescript-eslint/consistent-indexed-object-style
interface JsonObject {
  readonly [key: string]: JsonValue;
}

export const NODE_EXECUTION_LIMITS_V1 = NODE_JSON_LIMITS_V1;

export function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && !Array.isArray(value) && typeof value === 'object';
}

export function canonicalizeBoundedJson(
  value: unknown,
  limits: BoundedJsonLimits = NODE_EXECUTION_LIMITS_V1,
): JsonValue {
  if (
    !Number.isSafeInteger(limits.bytes) ||
    limits.bytes <= 0 ||
    !Number.isSafeInteger(limits.depth) ||
    limits.depth <= 0 ||
    !Number.isSafeInteger(limits.members) ||
    limits.members <= 0
  )
    throw new InvalidBoundedJsonError(
      'JSON limits must be positive safe integers',
    );
  const inspected = inspectBoundedJson(value, limits);
  if (!inspected.ok) throw new InvalidBoundedJsonError(inspected.reason);
  return inspected.value;
}
