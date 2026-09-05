import type { JsonValue } from './executor-contracts.js';
import { InvalidBoundedJsonError } from './executor-errors.js';
import { NODE_JSON_LIMITS_V1 } from './release.js';

// eslint-disable-next-line @typescript-eslint/consistent-indexed-object-style
interface JsonObject {
  readonly [key: string]: JsonValue;
}

export const NODE_EXECUTION_LIMITS_V1 = NODE_JSON_LIMITS_V1;

function isPlainObject(value: object): boolean {
  const prototype: object | null = Object.getPrototypeOf(value) as
    object | null;
  return prototype === Object.prototype || prototype === null;
}

export function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && !Array.isArray(value) && typeof value === 'object';
}

type MutableObject = Record<string, JsonValue>;

interface JsonFrame {
  readonly source: object;
  readonly target: MutableObject | JsonValue[];
  readonly keys: readonly string[];
  index: number;
  readonly depth: number;
}

function primitiveJson(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number' && Number.isFinite(value))
    return Object.is(value, -0) ? 0 : value;
  return undefined;
}

/**
 * Validate and normalize untrusted JSON with explicit stack frames. It never
 * follows user-controlled recursion and rejects cycles/accessors/prototypes.
 */
function canonicalizeBoundedJsonUnsafe(
  value: unknown,
  limits: Readonly<{ bytes: number; depth: number; members: number }>,
): JsonValue {
  const primitive = primitiveJson(value);
  if (primitive !== undefined) {
    if (
      new TextEncoder().encode(JSON.stringify(primitive)).byteLength >
      limits.bytes
    )
      throw new InvalidBoundedJsonError('JSON byte limit exceeded');
    return primitive;
  }
  if (typeof value !== 'object' || value === null)
    throw new InvalidBoundedJsonError('value is not JSON');

  const rootIsArray = Array.isArray(value);
  if (rootIsArray && value.length > limits.members)
    throw new InvalidBoundedJsonError('JSON member limit exceeded');
  if (!rootIsArray && !isPlainObject(value))
    throw new InvalidBoundedJsonError('object must be plain');
  if (Object.getOwnPropertySymbols(value).length > 0)
    throw new InvalidBoundedJsonError('symbol properties are not JSON');
  if (rootIsArray && Object.keys(value).length !== value.length)
    throw new InvalidBoundedJsonError('array properties are not JSON');
  const root: MutableObject | JsonValue[] = rootIsArray ? [] : {};
  const rootKeys = rootIsArray
    ? Array.from({ length: value.length }, (_, index) => String(index))
    : Object.keys(value);
  const seen = new Set<object>([value]);
  const stack: JsonFrame[] = [
    { source: value, target: root, keys: rootKeys, index: 0, depth: 1 },
  ];
  let members = 0;
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame === undefined) break;
    if (frame.index >= frame.keys.length) {
      stack.pop();
      continue;
    }
    const key = frame.keys[frame.index];
    frame.index += 1;
    if (key === undefined) continue;
    members += 1;
    if (members > limits.members)
      throw new InvalidBoundedJsonError('JSON member limit exceeded');
    const descriptor = Object.getOwnPropertyDescriptor(frame.source, key);
    if (descriptor === undefined || !('value' in descriptor))
      throw new InvalidBoundedJsonError('accessors are not JSON');
    if (Array.isArray(frame.source) && !Object.hasOwn(frame.source, key))
      throw new InvalidBoundedJsonError('sparse arrays are not JSON');
    const child: unknown = descriptor.value as unknown;
    const scalar = primitiveJson(child);
    if (scalar !== undefined) {
      if (Array.isArray(frame.target)) frame.target[Number(key)] = scalar;
      else
        Object.defineProperty(frame.target, key, {
          configurable: true,
          enumerable: true,
          value: scalar,
          writable: true,
        });
      continue;
    }
    if (typeof child !== 'object' || child === null)
      throw new InvalidBoundedJsonError('value is not JSON');
    const childDepth = frame.depth + 1;
    if (childDepth > limits.depth)
      throw new InvalidBoundedJsonError('JSON depth limit exceeded');
    if (seen.has(child))
      throw new InvalidBoundedJsonError('repeated object reference');
    if (!Array.isArray(child) && !isPlainObject(child))
      throw new InvalidBoundedJsonError('object must be plain');
    if (Object.getOwnPropertySymbols(child).length > 0)
      throw new InvalidBoundedJsonError('symbol properties are not JSON');
    const childIsArray = Array.isArray(child);
    if (childIsArray && child.length > limits.members)
      throw new InvalidBoundedJsonError('JSON member limit exceeded');
    if (childIsArray && Object.keys(child).length !== child.length)
      throw new InvalidBoundedJsonError('array properties are not JSON');
    const childTarget: MutableObject | JsonValue[] = childIsArray ? [] : {};
    if (Array.isArray(frame.target)) frame.target[Number(key)] = childTarget;
    else
      Object.defineProperty(frame.target, key, {
        configurable: true,
        enumerable: true,
        value: childTarget,
        writable: true,
      });
    const childKeys = childIsArray
      ? Array.from({ length: child.length }, (_, index) => String(index))
      : Object.keys(child);
    seen.add(child);
    stack.push({
      source: child,
      target: childTarget,
      keys: childKeys,
      index: 0,
      depth: childDepth,
    });
  }
  const result = root as JsonValue;
  const serialized = JSON.stringify(result);
  if (new TextEncoder().encode(serialized).byteLength > limits.bytes)
    throw new InvalidBoundedJsonError('JSON byte limit exceeded');
  return result;
}

export function canonicalizeBoundedJson(
  value: unknown,
  limits: Readonly<{
    bytes: number;
    depth: number;
    members: number;
  }> = NODE_EXECUTION_LIMITS_V1,
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
  try {
    return canonicalizeBoundedJsonUnsafe(value, limits);
  } catch (error) {
    if (error instanceof InvalidBoundedJsonError) throw error;
    throw new InvalidBoundedJsonError('value could not be inspected safely');
  }
}
